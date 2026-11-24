import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  limitOpenRouterAvailableSlots,
  listOpenRouterQueue,
  OBSOLETE_ROUTINE_IDS,
  openRouterLocalTerminationProof,
  openRouterRetryOptions,
  orderQueuedAgentIds,
  orderQueuedAgents,
  patchOpenRouterSources,
  reconcileOpenRouterControlPlane,
  reconcileOpenRouterControlPlaneSafely,
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
    routines: readFileSync(new URL(`${server}routines.js`, import.meta.url), "utf8"),
    agentsRoutes: readFileSync(new URL(`${server}../routes/agents.js`, import.meta.url), "utf8"),
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
  assert.match(patched.queue, /selectDistinct\(\{ agentId: heartbeatRuns\.agentId, companyId: heartbeatRuns\.companyId \}\)/);
  assert.match(patched.queue, /openRouterQueuedRunClaimableSql\(heartbeatRuns, sql\)/);
  assert.match(patched.queue, /selectClaimableQueuedRuns\(db, agent, heartbeatRuns,/);
  assert.match(patched.queue, /orderQueuedAgents\(/);
  assert.match(patched.queue, /const claimedRuns = await withOpenRouterClaimLock\(agent, async \(\) => \{/);
  assert.match(patched.queue, /limitOpenRouterAvailableSlots\(db, agent,/);
  assert.match(patched.queue, /triggerOpenRouterQueueDrain\(\(\) => resumeQueuedRunsAfterDrain\(\), logger\)/);
  assert.match(patched.routines, /await reconcileOpenRouterControlPlaneSafely\(db, sql, logger\)/);
  assert.match(patched.agentsRoutes, /openrouter-queue/);
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

test("control-plane cleanup uses SQL predicates instead of Drizzle UUID array interpolation", async () => {
  const queries = [];
  const sqlTag = (strings, ...values) => ({ text: strings.join("?"), values });
  const fakeDb = {
    async execute(query) {
      queries.push(query);
      if (query.text.includes("with stale_detached as")) {
        return {
          rows: [{
            id: "0af8d8bb-6243-4d8e-aa44-b83f55b348c6",
            company_id: "b8256505-bd3d-4321-9c59-f4c211b7e7fc",
            agent_id: "3691950c-473b-4ffd-9aa2-c9320440b8ca",
            error: "Lost in-memory process handle (different_process_space)",
          }],
        };
      }
      if (query.text.includes("from routines r\n    join companies c")) {
        return {
          rows: [{
            id: "23deafef-15aa-4b13-bace-1bba09b553e8",
            company_id: "6b160208-dbce-4f79-97df-34b49f97f442",
            title: "Old model watcher",
            reason: "obsolete_model_automation",
          }],
        };
      }
      return { rows: [] };
    },
  };
  const result = await reconcileOpenRouterControlPlane(fakeDb, sqlTag, { info() {} });
  assert.equal(result.detachedRunsRecovered, 1);
  assert.equal(result.routinesPaused, 0);
  assert.equal(result.routinesDeleted, 0);
  assert.ok(queries.some(query => query.text.includes("with stale_detached as")));
  assert.ok(queries.some(query => query.text.includes("update routine_triggers")));
  assert.ok(queries.some(query => query.text.includes("update routines")));
  assert.ok(queries.some(query => query.text.includes("cancel_routine_runs as")));
  assert.ok(queries.some(query => query.text.includes("delete from routines")));
  assert.ok(queries.some(query => query.values.includes(OBSOLETE_ROUTINE_IDS[4])));
  assert.doesNotMatch(queries.map(query => query.text).join("\n"), /any\(\?/);
  assert.doesNotMatch(queries.map(query => query.text).join("\n"), /lower\(coalesce\(r\.title[\s\S]*?~ \?/);
  assert.equal(queries.some(query => query.values.some(Array.isArray)), false);
});

test("control-plane cleanup failure cannot block scheduler or retry recovery", async () => {
  const errors = [];
  const result = await reconcileOpenRouterControlPlaneSafely({
    async execute() {
      throw new Error("synthetic cleanup failure");
    },
  }, (strings, ...values) => ({ strings, values }), {
    error(payload, message) {
      errors.push({ payload, message });
    },
  });
  assert.deepEqual(result, {
    detachedRunsRecovered: 0,
    policiesHealed: 0,
    routinesPaused: 0,
    issuesCancelled: 0,
    staleRunsCancelled: 0,
    routinesDeleted: 0,
    routinesDeferred: 0,
  });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].payload.tag, "openrouter.reconcile.control_plane_error");
  assert.match(errors[0].message, /execution recovery continues/);
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

  assert.equal(await limitOpenRouterAvailableSlots(fakeDb, orAgent, 3, sqlTag, {}), 3);
  activeCount = 2;
  assert.equal(await limitOpenRouterAvailableSlots(fakeDb, orAgent, 3, sqlTag, {}), 2);
  assert.equal(await limitOpenRouterAvailableSlots(fakeDb, orAgent, 3, sqlTag, { OPENROUTER_MAX_CONCURRENT_RUNS: "6" }), 3);
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

  const rows = [
    { companyId: "b-company", agentId: "b1" },
    { companyId: "a-company", agentId: "a1" },
    { companyId: "b-company", agentId: "b2" },
    { companyId: "a-company", agentId: "a2" },
  ];
  const fair = orderQueuedAgents(rows);
  assert.notEqual(fair[0][0], fair[1][0], "First queue turn must alternate companies.");
  assert.equal(fair.length, 4);
  assert.deepEqual(new Set(fair.slice(0, 2)).size, 2);
});

test("OpenRouter reserves one worker per queued company and throttles after quota bursts", async () => {
  let state = {
    running_global: 1,
    queued_companies: 2,
    running_company: 1,
    unserved_other_companies: 1,
    recent_quota_failures: 0,
  };
  const db = { async execute() { return { rows: [state] }; } };
  const sql = (strings, ...values) => ({ strings, values });
  const agent = { adapterType: "openrouter", companyId: "company-a" };
  assert.equal(await limitOpenRouterAvailableSlots(db, agent, 1, sql, {}), 0);
  state = { ...state, running_company: 0, unserved_other_companies: 0 };
  assert.equal(await limitOpenRouterAvailableSlots(db, agent, 2, sql, {}), 2);
  state = { ...state, running_global: 1, queued_companies: 2, recent_quota_failures: 3 };
  assert.equal(await limitOpenRouterAvailableSlots(db, agent, 2, sql, {}), 1);
});

test("OpenRouter queue endpoint returns per-company and per-agent positions", async () => {
  const now = new Date("2026-11-24T12:00:00Z");
  const db = {
    async execute() {
      return {
        rows: [
          { id: "running", status: "running", company_id: "c1", agent_id: "a1", agent_name: "A", created_at: now, median_duration_ms: 1000 },
          { id: "queued-a", status: "queued", company_id: "c1", agent_id: "a1", agent_name: "A", created_at: now, median_duration_ms: 2000, issue_identifier: "FE-1" },
          { id: "queued-b", status: "queued", company_id: "c1", agent_id: "a2", agent_name: "B", created_at: now, median_duration_ms: 3000 },
        ],
      };
    },
  };
  const queue = await listOpenRouterQueue(db, "c1", (strings, ...values) => ({ strings, values }));
  assert.equal(queue.queuedCount, 2);
  assert.equal(queue.runs[0].position, 0);
  assert.equal(queue.runs[1].position, 1);
  assert.equal(queue.runs[1].agentPosition, 1);
  assert.equal(queue.runs[2].position, 2);
  assert.equal(OBSOLETE_ROUTINE_IDS.length, 5);
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
      if (query.text.includes("with stale_detached as")) return { rows: [] };
      if (query.text.includes("update budget_policies p")) return { rows: [] };
      if (query.text.includes("insert into budget_policies")) return { rows: [] };
      if (query.text.includes("budget_monthly_cents")) return { rows: [] };
      if (query.text.includes("from routines r")) return { rows: [] };
      if (query.text.includes("with target_issues as")) return { rows: [] };
      if (query.text.includes("with queued as")) return { rows: [] };
      if (query.text.includes("set cron_expression = case")) return { rows: [] };
      if (query.text.includes("deferred_openrouter_backlog")) return { rows: [] };
      if (query.text.includes("delete from routines")) return { rows: [] };
      if (query.text.includes("count(distinct a.id)")) return { rows: [] };
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

