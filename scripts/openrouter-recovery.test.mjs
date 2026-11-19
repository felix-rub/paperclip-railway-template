import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  limitOpenRouterAvailableSlots,
  openRouterRetryOptions,
  orderQueuedAgentIds,
  patchOpenRouterSources,
  scheduleOpenRouterRetrySweep,
  triggerOpenRouterQueueDrain,
  withOpenRouterClaimLock,
  OPENROUTER_RETRY_MS,
} from "./openrouter-recovery.mjs";

test("OpenRouter retries use the persisted failure clock, never exponential backoff or a finite budget", () => {
  const finishedAt = new Date("2026-11-18T10:00:00Z");
  const agent = { adapterType: "openrouter" };
  const run = { finishedAt, scheduledRetryAttempt: 1_000_000 };
  for (const elapsed of [0, OPENROUTER_RETRY_MS - 1, OPENROUTER_RETRY_MS, OPENROUTER_RETRY_MS + 1]) {
    const now = new Date(+finishedAt + elapsed);
    const options = openRouterRetryOptions(run, agent, { now, maxAttempts: 2, delayMs: 1 });
    assert.equal(options.delayMs, Math.max(0, OPENROUTER_RETRY_MS - elapsed));
    assert.equal(options.maxAttempts, Infinity);
  }
  const options = { delayMs: 30_000, maxAttempts: 2 };
  assert.equal(openRouterRetryOptions(run, { adapterType: "codex_local" }, options), options);
  assert.throws(() => openRouterRetryOptions({ finishedAt: "invalid" }, agent), /timestamp/);
});

test("patch matches installed upstream, installs every hook, and remains idempotent", () => {
  const server = "../node_modules/@paperclipai/server/dist/services/";
  const sources = {
    retries: readFileSync(new URL(`${server}heartbeat/retries.js`, import.meta.url), "utf8"),
    completion: readFileSync(new URL(`${server}heartbeat/run-completion.js`, import.meta.url), "utf8"),
    recovery: readFileSync(new URL(`${server}recovery/service.js`, import.meta.url), "utf8"),
    pi: readFileSync(new URL("../node_modules/@paperclipai/adapter-pi-local/dist/server/runtime-config.js", import.meta.url), "utf8"),
    piExecute: readFileSync(new URL("../node_modules/@paperclipai/adapter-pi-local/dist/server/execute.js", import.meta.url), "utf8"),
    conversation: readFileSync(new URL(`${server}conversation-continuation.js`, import.meta.url), "utf8"),
    queue: readFileSync(new URL(`${server}heartbeat/queue.js`, import.meta.url), "utf8"),
    lifecycle: readFileSync(new URL("../node_modules/@paperclipai/server/dist/modules/agent-lifecycle/adapters/postgres.js", import.meta.url), "utf8"),
  };
  const patched = patchOpenRouterSources(sources);
  assert.deepEqual(patchOpenRouterSources(patched), patched);
  assert.match(patched.retries, /opts = openRouterRetryOptions/);
  assert.match(patched.retries, /openRouterPrevAdapter !== "openrouter"/);
  assert.match(patched.completion, /"failed", "timed_out", "interrupted"/);
  assert.match(patched.recovery, /scheduleOpenRouterRetrySweep\(db, deps, sql, logger\);/);
  assert.doesNotMatch(patched.recovery, /await reconcileOpenRouterRetries/);
  assert.match(patched.recovery, /const \[fullLatestRun\] = await db\.select\(\)\.from\(heartbeatRuns\)/);
  assert.match(patched.recovery, /runUsedConversationAdapter\(db, fullLatestRun\)/);
  assert.doesNotMatch(patched.recovery, /runUsedConversationAdapter\(db, latestRun\)/);
  assert.match(patched.queue, /selectDistinct\(\{ agentId: heartbeatRuns\.agentId \}\)/);
  assert.match(patched.queue, /openRouterQueuedRunClaimableSql\(heartbeatRuns, sql\)/);
  assert.match(patched.queue, /selectClaimableQueuedRuns\(db, agent, heartbeatRuns,/);
  assert.match(patched.queue, /orderQueuedAgentIds\(/);
  assert.match(patched.queue, /const claimedRuns = await withOpenRouterClaimLock\(agent, async \(\) => \{/);
  assert.match(patched.queue, /limitOpenRouterAvailableSlots\(db, agent,/);
  assert.match(patched.queue, /triggerOpenRouterQueueDrain\(\(\) => resumeQueuedRunsAfterDrain\(\), logger\)/);
  assert.match(patched.pi, /retry: \{ enabled: false, maxRetries: 0, provider: \{ maxRetries: 0 \} \}/);
  assert.match(patched.piExecute, /localSystemPromptPath/);
  assert.match(patched.piExecute, /stdin: !executionTargetIsRemote && userPrompt\.trim\(\)\.length > 0/);
  const changed = { ...sources, retries: "unexpected upstream implementation" };
  assert.throws(() => patchOpenRouterSources(changed), /no longer matches upstream/);
  assert.equal(changed.retries, "unexpected upstream implementation");
});

test("scheduleOpenRouterRetrySweep runs out-of-band in bounded batches without blocking startup", async () => {
  const remaining = [{ id: "r1" }, { id: "r2" }, { id: "r3" }];
  const scheduled = [];
  const fakeDb = {
    async execute() {
      return { rows: remaining.slice(0, 2) };
    },
  };
  const deps = {
    async scheduleRecoveryRetry(id) {
      scheduled.push(id);
      const idx = remaining.findIndex((r) => r.id === id);
      if (idx >= 0) remaining.splice(idx, 1);
    },
  };
  const sqlTag = (strings, ...values) => ({ strings, values });
  const logger = { error() {} };
  const started = scheduleOpenRouterRetrySweep(fakeDb, deps, sqlTag, logger, {
    initialDelayMs: 10,
    continuationDelayMs: 10,
    minIntervalMs: 500,
    limit: 2,
  });
  assert.equal(started, true);
  assert.deepEqual(scheduled, [], "Must not run synchronously on caller stack");
  assert.equal(scheduleOpenRouterRetrySweep(fakeDb, deps, sqlTag, logger, { initialDelayMs: 10 }), false);
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(scheduled, ["r1", "r2", "r3"]);
  assert.equal(scheduleOpenRouterRetrySweep(fakeDb, deps, sqlTag, logger, { initialDelayMs: 10, minIntervalMs: 500 }), false);
});

test("OpenRouter global concurrency lock, slot cap, and drain coalescer prevent thundering herds", async () => {
  let activeCount = 1;
  const fakeDb = { async execute() { return { rows: [{ count: activeCount }] }; } };
  const sqlTag = (strings, ...values) => ({ strings, values });
  const orAgent = { adapterType: "openrouter" };
  const otherAgent = { adapterType: "codex_local" };

  assert.equal(await limitOpenRouterAvailableSlots(fakeDb, orAgent, 3, sqlTag, {}), 1);
  activeCount = 2;
  assert.equal(await limitOpenRouterAvailableSlots(fakeDb, orAgent, 3, sqlTag, {}), 0);
  assert.equal(await limitOpenRouterAvailableSlots(fakeDb, orAgent, 3, sqlTag, { OPENROUTER_MAX_CONCURRENT_RUNS: "4" }), 2);
  assert.equal(await limitOpenRouterAvailableSlots(fakeDb, otherAgent, 3, sqlTag, {}), 3);

  const events = [];
  await Promise.all([
    withOpenRouterClaimLock(orAgent, async () => {
      events.push("a:start");
      await new Promise((r) => setTimeout(r, 20));
      events.push("a:end");
    }),
    withOpenRouterClaimLock(orAgent, async () => {
      events.push("b:start");
      events.push("b:end");
    }),
  ]);
  assert.deepEqual(events, ["a:start", "a:end", "b:start", "b:end"]);

  let drainCalls = 0;
  let releaseFirst;
  const firstGate = new Promise((r) => { releaseFirst = r; });
  triggerOpenRouterQueueDrain(async () => {
    drainCalls += 1;
    if (drainCalls === 1) await firstGate;
  });
  triggerOpenRouterQueueDrain(async () => { drainCalls += 1; });
  triggerOpenRouterQueueDrain(async () => { drainCalls += 1; });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(drainCalls, 1);
  releaseFirst();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(drainCalls, 2);

  const firstOrder = orderQueuedAgentIds(["a1", "a2", "a3", "a1"]);
  const secondOrder = orderQueuedAgentIds(["a1", "a2", "a3"]);
  const thirdOrder = orderQueuedAgentIds(["a1", "a2", "a3"]);
  assert.equal(firstOrder.length, 3);
  assert.notDeepEqual(firstOrder, secondOrder);
  assert.notDeepEqual(secondOrder, thirdOrder);
});
