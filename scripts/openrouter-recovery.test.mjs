import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  limitOpenRouterAvailableSlots,
  openRouterLocalTerminationProof,
  openRouterRetryOptions,
  orderQueuedAgentIds,
  patchOpenRouterSources,
  reconcileOpenRouterRetries,
  scheduleOpenRouterRetrySweep,
  triggerOpenRouterQueueDrain,
  withOpenRouterClaimLock,
  OPENROUTER_RETRY_MS,
} from "./openrouter-recovery.mjs";

test("committed budget Stops settle for finished local openrouter runs only", () => {
  const agent = { adapterType: "openrouter" };
  const local = [{ provider: "local" }];
  assert.equal(openRouterLocalTerminationProof({ terminal: true, inMemory: false, agent, leases: [] }), "openrouter_local_terminal");
  assert.equal(openRouterLocalTerminationProof({ terminal: true, inMemory: false, agent, leases: local }), "openrouter_local_terminal");
  assert.equal(openRouterLocalTerminationProof({ terminal: true, inMemory: true, agent, leases: local }), null);
  assert.equal(openRouterLocalTerminationProof({ terminal: false, inMemory: false, agent, leases: local }), null);
  assert.equal(openRouterLocalTerminationProof({ terminal: true, inMemory: false, agent, leases: [{ provider: "e2b" }] }), null);
  assert.equal(openRouterLocalTerminationProof({ terminal: true, inMemory: false, agent: { adapterType: "codex_local" }, leases: local }), null);
  assert.equal(openRouterLocalTerminationProof({ terminal: true, inMemory: false, agent: null, leases: local }), null);
});

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
    piModels: readFileSync(new URL("../node_modules/@paperclipai/adapter-pi-local/dist/server/models.js", import.meta.url), "utf8"),
    piMain: readFileSync(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/main.js", import.meta.url), "utf8"),
    conversation: readFileSync(new URL(`${server}conversation-continuation.js`, import.meta.url), "utf8"),
    queue: readFileSync(new URL(`${server}heartbeat/queue.js`, import.meta.url), "utf8"),
    lifecycle: readFileSync(new URL("../node_modules/@paperclipai/server/dist/modules/agent-lifecycle/adapters/postgres.js", import.meta.url), "utf8"),
    runControl: readFileSync(new URL(`${server}heartbeat/run-control.js`, import.meta.url), "utf8"),
  };
  const patched = patchOpenRouterSources(sources);
  assert.deepEqual(patchOpenRouterSources(patched), patched);
  assert.match(patched.runControl, /return openRouterLocalTerminationProof\(/);
  assert.match(patched.runControl, /async function upstreamCompletedRunTerminationProof\(run\)/);
  assert.match(patched.retries, /opts = openRouterRetryOptions/);
  assert.match(patched.retries, /openRouterPrevAdapter !== "openrouter"/);
  assert.match(patched.completion, /"failed", "timed_out", "interrupted"/);
  assert.match(patched.recovery, /scheduleOpenRouterRetrySweep\(db, \{ \.\.\.deps, resumeAgentLifecycle: \(targetDb, agentId\) => createAgentLifecycle\(targetDb\)\.resumeAgent\(agentId, "user"\), scheduleAgentLifecycle, notifyQueuedRunDispatch \}, sql, logger\);/);
  assert.doesNotMatch(patched.recovery, /await reconcileOpenRouterRetries/);
  assert.match(patched.lifecycle, /agent\.adapterType !== "openrouter"/);
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
  assert.match(patched.piExecute, /runtimeEnv\.PAPERCLIP_OPENROUTER_FREE_ONLY !== "1"/);
  assert.match(patched.piModels, /const stdoutModels = parseModelsOutput\(result\.stdout\)/);
  assert.match(patched.piModels, /searchPattern: slashIndex > 0 \? `\$\{model\.slice\(0, slashIndex\)\} \$\{model\.slice\(slashIndex \+ 1\)\}` : model/);
  assert.match(patched.piMain, /await flushStream\(process\.stdout\)/);
  assert.match(patched.piMain, /await flushStream\(process\.stderr\)/);
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

test("reconcileOpenRouterRetries unparks verifying agents, heals paused ready agents, and wakes queue dispatch", async () => {
  const scheduledLifecycles = [];
  const reconciledAgents = [];
  let notifiedQueue = 0;
  const infoLogs = [];
  const sqlTag = (strings, ...values) => ({ text: strings.join("?"), values });
  const fakeDb = {
    async transaction(fn) {
      return fn({ isTransaction: true });
    },
    async execute(query) {
      if (query.text.includes("set status = 'idle'")) return { rows: [{ id: "agent-healed-1" }] };
      if (query.text.includes("and a.lifecycle_state = 'paused'")) return { rows: [{ id: "agent-paused-1" }] };
      if (query.text.includes("a.lifecycle_state in ('verifying', 'preparing', 'resuming')")) {
        return { rows: query.values[0] === true ? [{ id: "agent-verifying-1" }, { id: "agent-verifying-2" }] : [] };
      }
      if (query.text.includes("update heartbeat_runs waiting")) return { rows: [] };
      if (query.text.includes("superseded_company_retries")) return { rows: [] };
      if (query.text.includes("select r.id")) return { rows: [] };
      if (query.text.includes("as ready_agents")) {
        return {
          rows: [{
            ready_agents: 2,
            verifying_agents: 0,
            paused_agents: 0,
            running_runs: 0,
            queued_runs: 5,
            scheduled_retry_runs: 3,
          }],
        };
      }
      throw new Error(`Unexpected SQL in test: ${query.text}`);
    },
  };
  const deps = {
    async scheduleRecoveryRetry() {},
    async resumeAgentLifecycle(_db, id) { reconciledAgents.push(id); },
    async scheduleAgentLifecycle(_db, id) { scheduledLifecycles.push(id); },
    async notifyQueuedRunDispatch(tx) {
      if (!tx?.isTransaction) {
        throw new Error("Database work must be registered inside a transaction");
      }
      notifiedQueue += 1;
    },
  };
  const logger = {
    info(payload, msg) { infoLogs.push({ payload, msg }); },
    error(payload, msg) { throw new Error(`${msg}: ${payload?.err?.message}`); },
  };

  const first = await reconcileOpenRouterRetries(fakeDb, deps, sqlTag, logger);
  assert.equal(first.healedAgents, 1);
  assert.equal(first.resumedAgents, 1);
  assert.equal(first.unparkedAgents, 2);
  assert.deepEqual(reconciledAgents, ["agent-paused-1"]);
  assert.deepEqual(scheduledLifecycles, ["agent-verifying-1", "agent-verifying-2"]);
  assert.equal(notifiedQueue, 1);
  assert.equal(infoLogs[0].payload.tag, "openrouter.reconcile.state");

  const second = await reconcileOpenRouterRetries(fakeDb, deps, sqlTag, logger);
  assert.equal(second.unparkedAgents, 0, "Boot retryAt force-unpark runs once per DB process");
});

test("all patched Paperclip server modules resolve valid named ESM exports", async () => {
  const targets = {
    retries: new URL("../node_modules/@paperclipai/server/dist/services/heartbeat/retries.js", import.meta.url),
    completion: new URL("../node_modules/@paperclipai/server/dist/services/heartbeat/run-completion.js", import.meta.url),
    recovery: new URL("../node_modules/@paperclipai/server/dist/services/recovery/service.js", import.meta.url),
    pi: new URL("../node_modules/@paperclipai/adapter-pi-local/dist/server/runtime-config.js", import.meta.url),
    piExecute: new URL("../node_modules/@paperclipai/adapter-pi-local/dist/server/execute.js", import.meta.url),
    piModels: new URL("../node_modules/@paperclipai/adapter-pi-local/dist/server/models.js", import.meta.url),
    piMain: new URL("../node_modules/@earendil-works/pi-coding-agent/dist/main.js", import.meta.url),
    conversation: new URL("../node_modules/@paperclipai/server/dist/services/conversation-continuation.js", import.meta.url),
    queue: new URL("../node_modules/@paperclipai/server/dist/services/heartbeat/queue.js", import.meta.url),
    lifecycle: new URL("../node_modules/@paperclipai/server/dist/modules/agent-lifecycle/adapters/postgres.js", import.meta.url),
    runControl: new URL("../node_modules/@paperclipai/server/dist/services/heartbeat/run-control.js", import.meta.url),
  };
  const sources = Object.fromEntries(Object.entries(targets).map(([k, url]) => [k, readFileSync(url, "utf8")]));
  const patched = patchOpenRouterSources(sources);
  const importRegex = /import\s+\{([^}]+)\}\s+from\s+"([^"]+)";/g;

  for (const [key, code] of Object.entries(patched)) {
    execFileSync(process.execPath, ["--input-type=module", "--check"], {
      input: code.replace(/^#!.*\r?\n/, ""),
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (key === "piMain") {
      assert.deepEqual(
        [...code.matchAll(importRegex)].map((m) => m[0]),
        [...sources.piMain.matchAll(importRegex)].map((m) => m[0]),
      );
      continue;
    }
    const baseUrl = targets[key];
    for (const match of code.matchAll(importRegex)) {
      const names = match[1]
        .split(",")
        .map((part) => part.trim().split(/\s+as\s+/)[0].trim())
        .filter(Boolean);
      const specifier = match[2];
      const resolvedUrl = specifier.startsWith(".") ? new URL(specifier, baseUrl).href : specifier;
      const mod = await import(resolvedUrl);
      for (const name of names) {
        assert.ok(name in mod, `Missing export '${name}' from '${specifier}' in patched '${key}'`);
      }
    }
  }
});

test("patched piModels recovers from truncated full discovery and stderr warnings via targeted fallback", async () => {
  const targets = {
    retries: new URL("../node_modules/@paperclipai/server/dist/services/heartbeat/retries.js", import.meta.url),
    completion: new URL("../node_modules/@paperclipai/server/dist/services/heartbeat/run-completion.js", import.meta.url),
    recovery: new URL("../node_modules/@paperclipai/server/dist/services/recovery/service.js", import.meta.url),
    pi: new URL("../node_modules/@paperclipai/adapter-pi-local/dist/server/runtime-config.js", import.meta.url),
    piExecute: new URL("../node_modules/@paperclipai/adapter-pi-local/dist/server/execute.js", import.meta.url),
    piModels: new URL("../node_modules/@paperclipai/adapter-pi-local/dist/server/models.js", import.meta.url),
    piMain: new URL("../node_modules/@earendil-works/pi-coding-agent/dist/main.js", import.meta.url),
    conversation: new URL("../node_modules/@paperclipai/server/dist/services/conversation-continuation.js", import.meta.url),
    queue: new URL("../node_modules/@paperclipai/server/dist/services/heartbeat/queue.js", import.meta.url),
    lifecycle: new URL("../node_modules/@paperclipai/server/dist/modules/agent-lifecycle/adapters/postgres.js", import.meta.url),
  };
  const sources = Object.fromEntries(Object.entries(targets).map(([k, url]) => [k, readFileSync(url, "utf8")]));
  const patched = patchOpenRouterSources(sources);

  const calls = [];
  globalThis.__openRouterPiModelsStub = async (_runId, _cmd, args) => {
    calls.push(args);
    if (args.length === 1 && args[0] === "--list-models") {
      const truncatedRows = Array.from(
        { length: 194 },
        (_, i) => `anthropic   claude-model-${i}   200k   8k   yes   yes`,
      ).join("\n");
      return {
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: `Warning: model registry warning\nprovider   model   context   max-out   thinking   images\n${truncatedRows}\n`,
      };
    }
    if (args[1] === "openrouter openrouter/free") {
      return {
        exitCode: 0,
        timedOut: false,
        stdout:
          "provider     model             context   max-out   thinking   images\nopenrouter   openrouter/free   128k      4k        no         no\n",
        stderr: "ExperimentalWarning: fake stderr warning",
      };
    }
    return {
      exitCode: 0,
      timedOut: false,
      stdout: "No models matching \"missing/model\"\n",
      stderr: "",
    };
  };

  const instrumentedCode = patched.piModels.replace(
    'import { asString, runChildProcess, sanitizeInheritedPaperclipEnv } from "@paperclipai/adapter-utils/server-utils";',
    [
      "const asString = (v, fallback) => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : fallback);",
      "const sanitizeInheritedPaperclipEnv = (env) => ({ ...env });",
      "const runChildProcess = (...args) => globalThis.__openRouterPiModelsStub(...args);",
    ].join("\n"),
  );
  const mod = await import(`data:text/javascript;base64,${Buffer.from(instrumentedCode, "utf8").toString("base64")}`);
  try {
    await mod.ensurePiModelConfiguredAndAvailable({
      model: "openrouter/openrouter/free",
      command: "pi",
      cwd: "/tmp",
      env: { OPENROUTER_API_KEY: "sk-test" },
    });
    assert.deepEqual(calls, [
      ["--list-models"],
      ["--list-models", "openrouter openrouter/free"],
    ]);

    // Second call hits healed cache without spawning another subprocess.
    await mod.ensurePiModelConfiguredAndAvailable({
      model: "openrouter/openrouter/free",
      command: "pi",
      cwd: "/tmp",
      env: { OPENROUTER_API_KEY: "sk-test" },
    });
    assert.equal(calls.length, 2);

    await assert.rejects(
      () =>
        mod.ensurePiModelConfiguredAndAvailable({
          model: "openrouter/missing-model",
          command: "pi",
          cwd: "/tmp",
          env: { OPENROUTER_API_KEY: "sk-test" },
        }),
      /Configured Pi model is unavailable: openrouter\/missing-model/,
    );
  } finally {
    delete globalThis.__openRouterPiModelsStub;
  }
});

