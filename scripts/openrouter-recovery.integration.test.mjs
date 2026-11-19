import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import {
  activityLog, agents, agentWakeupRequests, companies, heartbeatRuns, issues,
  applyPendingMigrations, closeRegisteredClients, createDb,
} from "@paperclipai/db";
import {
  enforceOpenRouterRecovery,
  hasOpenRouterHourlyWait,
  limitOpenRouterAvailableSlots,
  reconcileOpenRouterRetries,
  OPENROUTER_RETRY_MS,
} from "./openrouter-recovery.mjs";

test("durable hourly recovery survives restarts, exhausted budgets and concurrent schedulers", {
  skip: !process.env.OPENROUTER_TEST_DATABASE_URL, timeout: 120_000,
}, async () => {
  const url = process.env.OPENROUTER_TEST_DATABASE_URL;
  const parsed = new URL(url);
  assert.ok(["localhost", "127.0.0.1"].includes(parsed.hostname), "Test database must be local and disposable.");
  assert.equal(parsed.pathname, "/openrouter_retry_test");
  await applyPendingMigrations(url);
  enforceOpenRouterRecovery();
  const { createHeartbeatRetries } = await import("../node_modules/@paperclipai/server/dist/services/heartbeat/retries.js");
  const { createRunDispatch } = await import("../node_modules/@paperclipai/server/dist/modules/run-dispatch/index.js");
  const { evaluateAgentInvokabilityFromDb } = await import("../node_modules/@paperclipai/server/dist/services/agent-invokability.js");
  const { createLifecycleStore } = await import("../node_modules/@paperclipai/server/dist/modules/agent-lifecycle/adapters/postgres.js");
  const db = createDb(url);
  const now = new Date();
  const errors = [];
  const logger = { error: (...args) => errors.push(args) };
  function factory() {
    const callbacks = {
      hasCaseHandoffForRun: async () => false,
      appendRunEvent: async (_run, event) => {
        assert.notEqual(event.message, "Scheduled retry suppressed because the agent is not invokable", JSON.stringify(event.payload));
      },
      getAgentInvokability: agent => evaluateAgentInvokabilityFromDb(db, agent),
      runDispatch: createRunDispatch(db),
      resolveSessionBeforeForWakeup: async () => "persistent-session",
      resolveResponsibleUserIdForRunContext: async () => "retry-test-user",
      getRun: async id => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0],
      getAgent: async id => (await db.select().from(agents).where(eq(agents.id, id)))[0],
      applyRunDispatchPostCommitEffects: async () => {},
      getWorktreeExecutionCutoff: async () => null,
    };
    const retries = createHeartbeatRetries(db, callbacks);
    return {
      retries,
      scheduleRecoveryRetry: async id => {
        const run = await callbacks.getRun(id);
        const agent = await callbacks.getAgent(run.agentId);
        const result = await retries.scheduleBoundedRetryForRun(run, agent, { now });
        assert.equal(result.outcome, "scheduled", JSON.stringify(result));
        return result.run;
      },
    };
  }
  async function fixture({ issueStatus = "in_progress", agentStatus = "active", adapterType = "openrouter",
    dispatchAdapterType = adapterType, companyStatus = "active", runStatus = "failed", scopeKind = "issue",
    legacyIssueInSnapshotOnly = false, blockActor, code = "adapter_failed" } = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Hourly retry fixture", status: companyStatus, issuePrefix: `R${companyId.slice(0, 7)}`,
    });
    const [agent] = await db.insert(agents).values({
      companyId, name: "Fixture", adapterType, status: agentStatus,
      adapterConfig: { model: "openai/paid" },
    }).returning();
    const [issue] = (scopeKind === "issue" || legacyIssueInSnapshotOnly) ? await db.insert(issues).values({
      companyId, title: "Retry fixture", status: issueStatus, assigneeAgentId: agent.id,
    }).returning() : [];
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId: agent.id, scopeKind, issueId: legacyIssueInSnapshotOnly ? null : issue?.id,
      status: runStatus, errorCode: code, finishedAt: now, createdAt: new Date(+now - 1000),
      scheduledRetryAttempt: 1_000_000, scheduledRetryReason: "transient_failure",
      runnerProfileJson: dispatchAdapterType === null ? {} : { adapterDispatch: { adapterType: dispatchAdapterType } },
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      contextSnapshot: issue ? { issueId: issue.id, taskId: issue.id } : {},
    }).returning();
    if (issue) await db.update(issues).set({ executionRunId: run.id }).where(eq(issues.id, issue.id));
    if (blockActor) await db.insert(activityLog).values({
      companyId, actorType: blockActor, actorId: "test", action: "issue.updated",
      entityType: "issue", entityId: issue.id, details: { status: "blocked" },
    });
    return { companyId, agent, issue, run };
  }
  const successors = run => db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.retryOfRunId, run.id),
  ));
  try {
    const fixture1 = await fixture();
    const first = factory();
    const second = factory();
    const concurrent = await Promise.all([
      first.scheduleRecoveryRetry(fixture1.run.id), second.scheduleRecoveryRetry(fixture1.run.id),
    ]);
    assert.equal(concurrent[0].id, concurrent[1].id);
    let [retry] = await successors(fixture1.run);
    assert.equal((await successors(fixture1.run)).length, 1);
    assert.equal(retry.status, "scheduled_retry");
    assert.equal(+retry.scheduledRetryAt, +now + OPENROUTER_RETRY_MS);
    assert.equal(retry.scheduledRetryAttempt, 1_000_001);
    assert.equal(retry.sessionIdBefore, "persistent-session");
    assert.equal(retry.scopeKind, "issue");
    assert.equal(retry.contextSnapshot.taskId, fixture1.issue.id);
    assert.equal(await hasOpenRouterHourlyWait(db, fixture1.agent, sql), true);
    assert.equal(await hasOpenRouterHourlyWait(db, { ...fixture1.agent, adapterType: "codex_local" }, sql), false);

    // A recreated service sees the same persisted successor, not a fresh budget.
    const restarted = factory();
    assert.equal((await restarted.scheduleRecoveryRetry(fixture1.run.id)).id, retry.id);
    await restarted.retries.promoteDueScheduledRetries(new Date(+now + OPENROUTER_RETRY_MS - 1));
    [retry] = await successors(fixture1.run);
    assert.equal(retry.status, "scheduled_retry");
    await restarted.retries.promoteDueScheduledRetries(new Date(+now + OPENROUTER_RETRY_MS));
    [retry] = await successors(fixture1.run);
    assert.equal(retry.status, "queued");

    // Another failure after a million attempts still queues the next hour.
    await db.update(heartbeatRuns).set({
      status: "failed", finishedAt: new Date(+now + OPENROUTER_RETRY_MS),
      errorCode: "provider_quota", resultJson: { ...retry.resultJson, ...fixture1.run.resultJson },
      runnerProfileJson: fixture1.run.runnerProfileJson,
    }).where(eq(heartbeatRuns.id, retry.id));
    const repeated = await factory().scheduleRecoveryRetry(retry.id);
    assert.equal(+repeated.scheduledRetryAt, +now + 2 * OPENROUTER_RETRY_MS);
    assert.equal(repeated.scheduledRetryAttempt, 1_000_002);

    const standalone = await fixture({ scopeKind: "company", agentStatus: "error", code: "configuration_incomplete" });
    const blocked = await fixture({ issueStatus: "blocked", blockActor: "system" });
    const migratedFromOpencode = await fixture({ dispatchAdapterType: "opencode_local" });
    const migratedLegacySnapshot = await fixture({
      scopeKind: "company", legacyIssueInSnapshotOnly: true, dispatchAdapterType: "codex_local",
    });
    const preDispatchBootstrap = await fixture({ dispatchAdapterType: null });
    const archivedCompany = await fixture({ companyStatus: "archived", dispatchAdapterType: "opencode_local" });
    const stopped = await fixture({ runStatus: "cancelled" });
    const paused = await fixture({ agentStatus: "paused" });
    const done = await fixture({ issueStatus: "done" });
    const cancelled = await fixture({ issueStatus: "cancelled" });
    const other = await fixture({ adapterType: "codex_local" });
    const humanBlocked = await fixture({ issueStatus: "blocked", blockActor: "user" });
    const superseded = await fixture();
    await db.insert(heartbeatRuns).values({
      companyId: superseded.companyId, agentId: superseded.agent.id,
      scopeKind: "issue", issueId: superseded.issue.id, status: "succeeded",
      contextSnapshot: { issueId: superseded.issue.id },
    });
    await reconcileOpenRouterRetries(db, factory(), sql, logger);
    assert.equal((await successors(standalone.run)).length, 1);
    assert.equal((await successors(blocked.run)).length, 1);
    const [migratedRetry] = await successors(migratedFromOpencode.run);
    assert.ok(migratedRetry);
    assert.equal(migratedRetry.sessionIdBefore, null, "Cross-adapter migration must start a fresh Pi session.");
    assert.equal((await successors(migratedLegacySnapshot.run)).length, 1);
    assert.equal((await successors(preDispatchBootstrap.run)).length, 1);
    for (const f of [archivedCompany, stopped, paused, done, cancelled, other, humanBlocked, superseded]) {
      assert.equal((await successors(f.run)).length, 0, `Unexpected retry: ${f.run.id}`);
    }

    // Future agents require no configuration or registration changes.
    const future = await fixture({ runStatus: "timed_out" });
    await reconcileOpenRouterRetries(db, factory(), sql, logger);
    assert.equal((await successors(future.run)).length, 1);
    await reconcileOpenRouterRetries(db, factory(), sql, logger);
    assert.equal((await successors(future.run)).length, 1);
    assert.deepEqual(errors, []);

    // Newly hired agents can also wait for free quota during verification;
    // neither their accepted work nor their readiness operation is discarded.
    const setup = await fixture();
    const owner = randomUUID();
    const [verifying] = await db.update(agents).set({
      lifecycleState: "verifying",
      lifecycleOperation: { id: randomUUID(), attempts: 1_000_000, leaseOwner: owner },
    }).where(eq(agents.id, setup.agent.id)).returning();
    const store = createLifecycleStore(db, {});
    assert.equal(await store.defer(verifying, owner, "Synthetic free quota failure", now), true);
    const deferred = await store.get(verifying.id);
    assert.equal(+new Date(deferred.lifecycleOperation.retryAt), +now + OPENROUTER_RETRY_MS);
    assert.equal(await store.claim(verifying.id, owner, new Date(+now + OPENROUTER_RETRY_MS - 1)), null);
    const readyToRetry = await store.claim(verifying.id, owner, new Date(+now + OPENROUTER_RETRY_MS));
    assert.equal(readyToRetry.lifecycleOperation.attempts, 1_000_001);

    // Company-scoped runs with distinct historical taskKeys deduplicate to a single retry
    // per agent, and pre-existing redundant company retries are cancelled along with wakeups.
    const companyDedup = await fixture({ scopeKind: "company", code: "adapter_failed" });
    const [newerCompanyFailure] = await db.insert(heartbeatRuns).values({
      companyId: companyDedup.companyId,
      agentId: companyDedup.agent.id,
      invocationSource: "timer",
      scopeKind: "company",
      status: "failed",
      errorCode: "adapter_failed",
      finishedAt: new Date(+now + 5_000),
      createdAt: new Date(+now + 5_000),
      contextSnapshot: { taskKey: `timer-${randomUUID()}` },
      runnerProfileJson: { adapterDispatch: { adapterType: "openrouter" } },
      resultJson: {},
    }).returning();
    await reconcileOpenRouterRetries(db, factory(), sql, logger);
    assert.equal((await successors(companyDedup.run)).length, 0, "Older company failure must be superseded by newer company run");
    const [latestCompanyRetry] = await successors(newerCompanyFailure);
    assert.ok(latestCompanyRetry, "Latest company failure must still schedule one hourly retry");

    const [staleWake] = await db.insert(agentWakeupRequests).values({
      companyId: companyDedup.companyId,
      agentId: companyDedup.agent.id,
      source: "automation",
      status: "queued",
    }).returning();
    const [staleDupRetry] = await db.insert(heartbeatRuns).values({
      companyId: companyDedup.companyId,
      agentId: companyDedup.agent.id,
      invocationSource: "automation",
      scopeKind: "company",
      status: "scheduled_retry",
      retryOfRunId: companyDedup.run.id,
      wakeupRequestId: staleWake.id,
      scheduledRetryAt: new Date(+now + OPENROUTER_RETRY_MS),
      createdAt: new Date(+now - 10_000),
      contextSnapshot: { taskKey: `stale-${randomUUID()}` },
    }).returning();
    await reconcileOpenRouterRetries(db, factory(), sql, logger);
    const [cleanedRetry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, staleDupRetry.id));
    const [cleanedWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, staleWake.id));
    const [preservedRetry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, latestCompanyRetry.id));
    assert.equal(cleanedRetry.status, "cancelled");
    assert.equal(cleanedWake.status, "cancelled");
    assert.equal(preservedRetry.status, "scheduled_retry");

    // Global OpenRouter concurrency limit counts running OpenRouter runs across orgs.
    const runningA = await fixture({ runStatus: "running" });
    const runningB = await fixture({ runStatus: "running" });
    const candidateOr = await fixture();
    assert.ok(runningA && runningB);
    assert.equal(await limitOpenRouterAvailableSlots(db, candidateOr.agent, 2, sql, {}), 0);
    assert.equal(await limitOpenRouterAvailableSlots(db, other.agent, 2, sql, {}), 2);
  } finally {
    await closeRegisteredClients(url);
  }
});
