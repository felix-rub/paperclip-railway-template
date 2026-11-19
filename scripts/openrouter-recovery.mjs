import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export const OPENROUTER_RETRY_MS = 60 * 60 * 1000;
export const DEFAULT_OPENROUTER_MAX_CONCURRENT_RUNS = 2;
const DEFAULT_SWEEP_BATCH_LIMIT = 25;
const DEFAULT_DIRECT_SWEEP_LIMIT = 200;
const DEFAULT_SWEEP_INITIAL_DELAY_MS = 2_000;
const DEFAULT_SWEEP_CONTINUATION_DELAY_MS = 2_000;
const DEFAULT_SWEEP_MIN_INTERVAL_MS = 60_000;

export function resolveOpenRouterMaxConcurrentRuns(env = process.env) {
  const raw = env?.OPENROUTER_MAX_CONCURRENT_RUNS;
  if (raw !== undefined && raw !== "") {
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed) && parsed >= 1) return parsed;
  }
  return DEFAULT_OPENROUTER_MAX_CONCURRENT_RUNS;
}

let openRouterClaimChain = Promise.resolve();

export function withOpenRouterClaimLock(agent, fn) {
  if (agent?.adapterType !== "openrouter") return fn();
  const next = openRouterClaimChain.then(fn, fn);
  openRouterClaimChain = next.then(() => undefined, () => undefined);
  return next;
}

export async function limitOpenRouterAvailableSlots(db, agent, availableSlots, sql, env = process.env) {
  if (agent?.adapterType !== "openrouter" || availableSlots <= 0) return availableSlots;
  const globalMax = resolveOpenRouterMaxConcurrentRuns(env);
  const result = await db.execute(sql`
    select count(*)::int as count
    from heartbeat_runs r
    join agents a on a.id = r.agent_id and a.company_id = r.company_id
    where r.status = 'running'
      and a.adapter_type = 'openrouter'
  `);
  const rows = result.rows ?? result;
  if (!Array.isArray(rows)) throw new Error("Unexpected OpenRouter concurrency query result.");
  const runningGlobal = Number(rows[0]?.count ?? 0);
  return Math.max(0, Math.min(availableSlots, globalMax - runningGlobal));
}

let drainInFlight = false;
let drainRerunRequested = false;

export function triggerOpenRouterQueueDrain(resumeFn, logger) {
  if (drainInFlight) {
    drainRerunRequested = true;
    return;
  }
  drainInFlight = true;
  void (async () => {
    do {
      drainRerunRequested = false;
      try {
        await resumeFn();
      } catch (error) {
        logger?.warn?.({ err: error }, "failed to resume queued OpenRouter runs after completion");
      }
    } while (drainRerunRequested);
  })().finally(() => {
    drainInFlight = false;
  });
}

export function openRouterRetryOptions(run, agent, options) {
  if (agent.adapterType !== "openrouter") return options;
  const now = options?.now ?? new Date();
  const finishedAt = new Date(run.finishedAt ?? now);
  if (!Number.isFinite(finishedAt.getTime())) throw new Error("Invalid OpenRouter failure timestamp.");
  return {
    ...options,
    maxAttempts: Number.POSITIVE_INFINITY,
    delayMs: Math.max(0, finishedAt.getTime() + OPENROUTER_RETRY_MS - now.getTime()),
  };
}

export async function hasOpenRouterHourlyWait(db, agent, sql) {
  if (agent.adapterType !== "openrouter") return false;
  const result = await db.execute(sql`
    select 1 from heartbeat_runs waiting
    join heartbeat_runs predecessor on predecessor.id = waiting.retry_of_run_id
      and predecessor.company_id = waiting.company_id
    where waiting.agent_id = ${agent.id} and waiting.company_id = ${agent.companyId}
      and waiting.status = 'scheduled_retry'
      and predecessor.status in ('failed', 'timed_out', 'interrupted')
    limit 1
  `);
  const rows = result.rows ?? result;
  if (!Array.isArray(rows)) throw new Error("Unexpected OpenRouter wait query result.");
  return rows.length > 0;
}

// The ordinary retry service owns locks, authorization, session inheritance and
// successor deduplication. This sweep only recovers terminal work it missed.
export async function reconcileOpenRouterRetries(db, deps, sql, logger, opts = {}) {
  if (!deps.scheduleRecoveryRetry) return { selected: 0, scheduled: 0 };
  const limit = Number.isSafeInteger(opts?.limit) && opts.limit > 0 ? opts.limit : DEFAULT_DIRECT_SWEEP_LIMIT;
  await db.execute(sql`
    update heartbeat_runs waiting
    set scheduled_retry_at = predecessor.finished_at + interval '1 hour',
        context_snapshot = jsonb_set(coalesce(waiting.context_snapshot, '{}'::jsonb),
          '{scheduledRetryAt}', to_jsonb(predecessor.finished_at + interval '1 hour')),
        updated_at = now()
    from heartbeat_runs predecessor, agents a
    where waiting.retry_of_run_id = predecessor.id
      and waiting.company_id = predecessor.company_id
      and a.id = waiting.agent_id and a.company_id = waiting.company_id
      and a.adapter_type = 'openrouter'
      and waiting.status = 'scheduled_retry'
      and predecessor.status in ('failed', 'timed_out', 'interrupted')
      and predecessor.finished_at is not null
      and waiting.scheduled_retry_at is distinct from predecessor.finished_at + interval '1 hour'
  `);
  await db.execute(sql`
    with superseded_company_retries as (
      update heartbeat_runs waiting
      set status = 'cancelled',
          finished_at = coalesce(waiting.finished_at, now()),
          error = coalesce(waiting.error, 'Superseded by newer company-scoped OpenRouter run'),
          updated_at = now()
      from agents a
      where a.id = waiting.agent_id and a.company_id = waiting.company_id
        and a.adapter_type = 'openrouter'
        and waiting.scope_kind = 'company'
        and nullif(coalesce(waiting.issue_id::text, waiting.context_snapshot ->> 'issueId'), '') is null
        and waiting.retry_of_run_id is not null
        and (
          waiting.status = 'scheduled_retry'
          or (waiting.status = 'queued' and waiting.started_at is null)
        )
        and exists (
          select 1 from heartbeat_runs newer
          where newer.company_id = waiting.company_id
            and newer.agent_id = waiting.agent_id
            and newer.scope_kind = 'company'
            and nullif(coalesce(newer.issue_id::text, newer.context_snapshot ->> 'issueId'), '') is null
            and newer.status in ('scheduled_retry', 'queued', 'running')
            and (newer.created_at, newer.id) > (waiting.created_at, waiting.id)
        )
      returning waiting.wakeup_request_id
    )
    update agent_wakeup_requests w
    set status = 'cancelled',
        finished_at = coalesce(w.finished_at, now()),
        error = coalesce(w.error, 'Superseded by newer company-scoped OpenRouter run'),
        updated_at = now()
    from superseded_company_retries s
    where s.wakeup_request_id is not null
      and w.id = s.wakeup_request_id
      and w.status in ('queued', 'claimed', 'deferred_issue_execution')
  `);
  const result = await db.execute(sql`
    select r.id
    from heartbeat_runs r
    join companies c on c.id = r.company_id and c.status = 'active'
    join agents a on a.id = r.agent_id and a.company_id = r.company_id
    left join issues i on i.company_id = r.company_id
      and i.id::text = nullif(coalesce(r.issue_id::text, r.context_snapshot ->> 'issueId'), '')
    where a.adapter_type = 'openrouter'
      and a.status not in ('paused', 'terminated', 'pending_approval')
      and r.status in ('failed', 'timed_out', 'interrupted')
      and coalesce(r.runtime_mode, 'local') <> 'native'
      and coalesce(r.result_json ->> 'workspaceRestoreFailure', '') <> 'restore_unsafe_archive'
      and coalesce(r.result_json -> 'workspaceRestoreRecovery' ->> 'schema', '') <>
        'paperclip.workspace-restore-recovery.v1'
      and (
        coalesce(r.runner_profile_json -> 'adapterDispatch' ->> 'adapterType', '') in
          ('claude_local', 'codex_local', 'cursor', 'gemini_local', 'opencode_local',
           'pi_local', 'grok_local', 'kimi_local', 'hermes_local', 'openrouter')
        or coalesce(r.result_json ->> 'conversationContinuation', '') = 'continue_conversation_v1'
        or exists (select 1 from heartbeat_run_events e
          where e.run_id = r.id and e.company_id = r.company_id
            and e.event_type = 'adapter.invoke'
            and coalesce(e.payload ->> 'adapterType', '') in
              ('claude_local', 'codex_local', 'cursor', 'gemini_local', 'opencode_local',
               'pi_local', 'grok_local', 'kimi_local', 'hermes_local', 'openrouter'))
        or (
          r.runner_profile_json -> 'adapterDispatch' ->> 'adapterType' is null
          and coalesce(r.result_json -> 'executionRecovery' ->> 'providerWorkStarted', '') = 'false'
          and not exists (select 1 from heartbeat_run_events e
            where e.run_id = r.id and e.company_id = r.company_id and e.event_type = 'adapter.invoke')
        )
      )
      and coalesce(r.error_code, '') not in
        ('operator_interrupted', 'agent_paused', 'chat_control_stop', 'chat_control_unresolved')
      and (
        (nullif(coalesce(r.issue_id::text, r.context_snapshot ->> 'issueId'), '') is null and r.scope_kind = 'company')
        or (
          i.id is not null and i.hidden_at is null and i.assignee_user_id is null
          and i.status in ('todo', 'in_progress', 'in_review', 'blocked')
          and (i.assignee_agent_id = a.id or i.status = 'in_review')
          and (i.status <> 'blocked' or (
            select l.actor_type = 'system'
            from activity_log l
            where l.company_id = i.company_id and l.entity_type = 'issue'
              and l.entity_id = i.id::text and l.details ->> 'status' is not null
            order by l.created_at desc, l.id desc limit 1
          ))
        )
      )
      and not exists (
        select 1 from heartbeat_runs successor
        where successor.company_id = r.company_id and successor.retry_of_run_id = r.id
      )
      and not exists (
        select 1 from heartbeat_runs newer
        where newer.company_id = r.company_id
          and (
            (i.id is not null and nullif(coalesce(newer.issue_id::text, newer.context_snapshot ->> 'issueId'), '') = i.id::text)
            or (
              i.id is null
              and newer.agent_id = r.agent_id
              and newer.scope_kind = 'company'
              and nullif(coalesce(newer.issue_id::text, newer.context_snapshot ->> 'issueId'), '') is null
              and (
                newer.status in ('scheduled_retry', 'queued', 'running')
                or (newer.created_at, newer.id) > (r.created_at, r.id)
              )
            )
          )
          and (
            i.id is null
            or (newer.created_at, newer.id) > (r.created_at, r.id)
          )
      )
      and not exists (
        select 1 from agent_task_sessions s
        where s.company_id = r.company_id and s.agent_id = r.agent_id
          and s.task_key = coalesce(i.id::text, r.context_snapshot ->> 'taskKey')
          and s.goal_desired_state = 'paused'
      )
      and not exists (
        select 1 from heartbeat_run_events suppressed
        where suppressed.run_id = r.id and suppressed.company_id = r.company_id
          and suppressed.event_type = 'lifecycle' and suppressed.level = 'warn'
          and suppressed.payload -> 'scheduledRetryAttempt' is not null
          and suppressed.created_at > now() - interval '1 hour'
      )
    order by r.created_at, r.id
    limit ${limit}
  `);
  const rows = result.rows ?? result;
  if (!Array.isArray(rows)) throw new Error("Unexpected OpenRouter recovery query result.");
  let scheduled = 0;
  for (const row of rows) {
    try {
      await deps.scheduleRecoveryRetry(row.id);
      scheduled += 1;
    } catch (error) {
      logger.error({ err: error, runId: row.id }, "OpenRouter hourly retry scheduling failed; the next sweep will retry");
    }
  }
  return { selected: rows.length, scheduled };
}

const sweepStates = new WeakMap();

// Schedule OpenRouter retry reconciliation out-of-band so startup issue-state
// recovery (`registerIssueStateRecoveryWork(...).ready`) never blocks readiness.
export function scheduleOpenRouterRetrySweep(db, deps, sql, logger, opts = {}) {
  if (!db || typeof db !== "object" || !deps?.scheduleRecoveryRetry) return false;
  let state = sweepStates.get(db);
  if (!state) {
    state = { timer: null, inFlight: false, lastFinishedAt: 0 };
    sweepStates.set(db, state);
  }
  if (state.timer || state.inFlight) return false;
  const initialDelayMs = opts.initialDelayMs ?? DEFAULT_SWEEP_INITIAL_DELAY_MS;
  const continuationDelayMs = opts.continuationDelayMs ?? DEFAULT_SWEEP_CONTINUATION_DELAY_MS;
  const minIntervalMs = opts.minIntervalMs ?? DEFAULT_SWEEP_MIN_INTERVAL_MS;
  const batchLimit = opts.limit ?? DEFAULT_SWEEP_BATCH_LIMIT;
  const now = Date.now();
  if (state.lastFinishedAt > 0 && now - state.lastFinishedAt < minIntervalMs) return false;
  const schedulePass = (delayMs) => {
    state.timer = setTimeout(async () => {
      state.timer = null;
      state.inFlight = true;
      let moreRemain = false;
      try {
        const res = await reconcileOpenRouterRetries(db, deps, sql, logger, { limit: batchLimit });
        moreRemain = (res?.selected ?? 0) >= batchLimit;
      } catch (error) {
        logger?.error?.({ err: error }, "OpenRouter background retry sweep failed");
      } finally {
        state.inFlight = false;
        state.lastFinishedAt = Date.now();
        if (moreRemain && !state.timer) {
          schedulePass(continuationDelayMs);
        }
      }
    }, delayMs);
    state.timer.unref?.();
  };
  schedulePass(initialDelayMs);
  return true;
}

function replaceOnce(source, before, after) {
  const befores = Array.isArray(before) ? before : [before];
  const afters = Array.isArray(after) ? after : [after];
  if (afters.some(candidate => source.includes(candidate))) return source;
  const matchedIndex = befores.findIndex(candidate => source.split(candidate).length === 2);
  if (matchedIndex === -1) {
    throw new Error(`OpenRouter recovery patch no longer matches upstream: ${befores[0].slice(0, 100)}`);
  }
  return source.replace(befores[matchedIndex], afters[Math.min(matchedIndex, afters.length - 1)]);
}

export function patchOpenRouterSources(sources, moduleUrl = import.meta.url) {
  const output = { ...sources };
  const imported = names => `import { ${names} } from ${JSON.stringify(moduleUrl)};\n`;
  output.retries = replaceOnce(output.retries,
    '    async function scheduleBoundedRetryForRun(run, agent, opts) {',
    `    async function scheduleBoundedRetryForRun(run, agent, opts) {
        opts = openRouterRetryOptions(run, agent, opts);`);
  output.retries = replaceOnce(output.retries,
    'import { CONVERSATION_CONTINUATION_POLICY, hasConversationContinuationPolicy, }',
    'import { CONVERSATION_CONTINUATION_POLICY, hasConversationContinuationPolicy, historicalAdapterType, runUsedConversationAdapter, }');
  output.retries = replaceOnce(output.retries,
    '        const now = opts?.now ?? new Date();',
    `        const openRouterPrevAdapter = agent.adapterType === "openrouter" ? await historicalAdapterType(db, run) : null;
        if (agent.adapterType === "openrouter" &&
            (openRouterPrevAdapter === "openrouter" ||
                await runUsedConversationAdapter(db, run) ||
                (openRouterPrevAdapter === null && run.resultJson?.executionRecovery?.providerWorkStarted === false))) {
            if (run.resultJson?.conversationContinuation !== CONVERSATION_CONTINUATION_POLICY) {
                const nextResultJson = { ...run.resultJson, conversationContinuation: CONVERSATION_CONTINUATION_POLICY };
                run = { ...run, resultJson: nextResultJson };
                if (run.runtimeMode !== "native") {
                    await db.update(heartbeatRuns)
                        .set({ resultJson: nextResultJson })
                        .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId)));
                }
            }
        }
        const now = opts?.now ?? new Date();`);
  if (!output.retries.includes(imported("openRouterRetryOptions"))) {
    output.retries = imported("openRouterRetryOptions") + output.retries;
  }
  output.retries = replaceOnce(output.retries,
    'if (run.errorCode === "provider_tool_definition_invalid") {',
    'if (agent.adapterType !== "openrouter" && run.errorCode === "provider_tool_definition_invalid") {');
  output.retries = replaceOnce(output.retries,
    'const transientRetryNotBefore = transientRecovery?.retryNotBefore ?? null;',
    'const transientRetryNotBefore = agent.adapterType === "openrouter" ? null : (transientRecovery?.retryNotBefore ?? null);');
  output.retries = replaceOnce(output.retries,
    '        const requiresIssueGate = ',
    '        const requiresIssueGate = agent.adapterType === "openrouter" || ');
  output.retries = replaceOnce(output.retries,
    '        const sessionBefore = await resolveSessionBeforeForWakeup(agent, taskKey);',
    '        const sessionBefore = agent.adapterType === "openrouter" && openRouterPrevAdapter !== "openrouter" ? null : await resolveSessionBeforeForWakeup(agent, taskKey);');
  output.completion = replaceOnce(output.completion,
    'if (outcome === "failed" && isMaxTurnExhaustionRun(livenessRun)) {',
    'if (agent.adapterType === "openrouter" && ["failed", "timed_out", "interrupted"].includes(outcome)) {\n                await scheduleBoundedRetryForRun(livenessRun, agent);\n            }\n            else if (outcome === "failed" && isMaxTurnExhaustionRun(livenessRun)) {');
  output.completion = replaceOnce(output.completion,
    '            await scheduleInteractionContinuationInfrastructureRetryIfEligible(livenessRun, agent);\n            await releaseIssueExecutionAndPromote(livenessRun, {',
    '            await (failureOutcome === "failed" && agent.adapterType === "openrouter" ? scheduleBoundedRetryForRun(livenessRun, agent) : scheduleInteractionContinuationInfrastructureRetryIfEligible(livenessRun, agent));\n            await releaseIssueExecutionAndPromote(livenessRun, {');
  output.completion = replaceOnce(output.completion,
    [
      'await (isTransientWorkspacePreparationCode(livenessRun.errorCode)',
      'await (isTransientWorkspaceGitScanCode(livenessRun.errorCode)',
    ],
    [
      'await (failedAgent.adapterType === "openrouter" || isTransientWorkspacePreparationCode(livenessRun.errorCode)',
      'await (failedAgent.adapterType === "openrouter" || isTransientWorkspaceGitScanCode(livenessRun.errorCode)',
    ]);
  output.recovery = replaceOnce(output.recovery,
    'import { isAgentAwaitingSetup } from "../../modules/agent-lifecycle/index.js";',
    'import { isAgentAwaitingSetup } from "../../modules/agent-lifecycle/index.js";\nimport { runUsedConversationAdapter } from "../conversation-continuation.js";');
  output.recovery = replaceOnce(output.recovery,
    '    async function reconcileStrandedAssignedIssues(opts) {',
    '    async function reconcileStrandedAssignedIssues(opts) {\n        scheduleOpenRouterRetrySweep(db, deps, sql, logger);');
  if (!output.recovery.includes(imported("scheduleOpenRouterRetrySweep"))) {
    output.recovery = imported("scheduleOpenRouterRetrySweep") + output.recovery;
  }
  output.recovery = replaceOnce(output.recovery,
    '            let latestRun = await getLatestIssueRun(issue.companyId, issue.id);',
    `            let latestRun = await getLatestIssueRun(issue.companyId, issue.id);
            if (latestRun && latestRun.agentId === agentId &&
                ["failed", "timed_out", "interrupted"].includes(latestRun.status) &&
                (await getAgent(agentId))?.adapterType === "openrouter" &&
                (await runUsedConversationAdapter(db, latestRun) ||
                    latestRun.resultJson?.executionRecovery?.providerWorkStarted === false)) {
                // The persistent hourly lane owns conversation/bootstrap failures; never
                // escalate them or restart them via the generic 60-second continuation lane.
                result.skipped += 1;
                continue;
            }`);
  const modelsWrite = 'await fs.writeFile(path.join(agentConfigDir, "models.json"), `${JSON.stringify({ providers }, null, 2)}\\n`, "utf8");';
  output.pi = replaceOnce(output.pi, modelsWrite, `${modelsWrite}
        if (input.env.PAPERCLIP_OPENROUTER_FREE_ONLY === "1") {
            await fs.writeFile(path.join(agentConfigDir, "settings.json"), JSON.stringify({
                retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } }
            }), "utf8");
        }`);
  output.piExecute = replaceOnce(output.piExecute,
    '    let attributionExtension;',
    '    let attributionExtension;\n    let localSystemPromptDir = null;');
  output.piExecute = replaceOnce(output.piExecute,
    '        const renderedSystemPromptExtension = renderTemplate(systemPromptExtension, templateData);',
    `        const renderedSystemPromptExtension = renderTemplate(systemPromptExtension, templateData);
        const localSystemPromptPath = !executionTargetIsRemote && renderedSystemPromptExtension.length > 0
            ? await (async () => {
                localSystemPromptDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-system-prompt-"));
                const targetPath = path.join(localSystemPromptDir, "system-prompt.md");
                await fs.writeFile(targetPath, renderedSystemPromptExtension, "utf8");
                return targetPath;
            })()
            : null;`);
  output.piExecute = replaceOnce(output.piExecute,
    '            args.push("--append-system-prompt", renderedSystemPromptExtension);',
    '            args.push("--append-system-prompt", localSystemPromptPath ?? renderedSystemPromptExtension);');
  output.piExecute = replaceOnce(output.piExecute,
    '            args.push(userPrompt);',
    '            if (executionTargetIsRemote || userPrompt.trim().length === 0) args.push(userPrompt);');
  output.piExecute = replaceOnce(output.piExecute,
    '                env: executionTargetIsRemote ? env : runtimeEnv,',
    '                env: executionTargetIsRemote ? env : runtimeEnv,\n                stdin: !executionTargetIsRemote && userPrompt.trim().length > 0 ? userPrompt : undefined,');
  output.piExecute = replaceOnce(output.piExecute,
    '        await Promise.all([preparedRuntimeConfig.cleanup(), attributionExtension?.cleanup()]);',
    '        await Promise.all([preparedRuntimeConfig.cleanup(), attributionExtension?.cleanup(), localSystemPromptDir ? fs.rm(localSystemPromptDir, { recursive: true, force: true }).catch(() => undefined) : Promise.resolve()]);');
  output.conversation = replaceOnce(output.conversation,
    '    "pi_local", "grok_local", "kimi_local", "hermes_local",',
    '    "pi_local", "grok_local", "kimi_local", "hermes_local", "openrouter",');
  output.queue = replaceOnce(output.queue,
    '            const policy = parseHeartbeatPolicy(agent);\n            const runningCount = await countRunningRunsForAgent(agentId);\n            const availableSlots = Math.max(0, policy.maxConcurrentRuns - runningCount);',
    `            return withOpenRouterClaimLock(agent, async () => {
            const policy = parseHeartbeatPolicy(agent);
            const runningCount = await countRunningRunsForAgent(agentId);
            const availableSlots = await limitOpenRouterAvailableSlots(db, agent, Math.max(0, policy.maxConcurrentRuns - runningCount), sql);`);
  output.queue = replaceOnce(output.queue,
    `                void execution.finally(() => {
                    // drainActiveRunExecutions loops on activeRunExecutionPromises.size,
                    // so an entry that never clears here would hang it forever.
                    activeRunExecutionPromises.delete(execution);
                });
            }
            return claimedRuns;
        }).finally(async () => {`,
    `                void execution.finally(() => {
                    // drainActiveRunExecutions loops on activeRunExecutionPromises.size,
                    // so an entry that never clears here would hang it forever.
                    activeRunExecutionPromises.delete(execution);
                    if (agent.adapterType === "openrouter") {
                        triggerOpenRouterQueueDrain(() => resumeQueuedRunsAfterDrain(), logger);
                    }
                });
            }
            return claimedRuns;
            });
        }).finally(async () => {`);
  output.queue = replaceOnce(output.queue,
    '        if (policy.skipTimerWhenNoActionableWork &&',
    `        if (genericTimerWake && await hasOpenRouterHourlyWait(db, agent, sql)) {
            await writeSkippedHeartbeatRequest("heartbeat.openrouter.hourly_wait", {
                reason: "An OpenRouter hourly retry already owns this agent's pending work.",
            });
            await markTimerHeartbeatChecked(agentId, source);
            return null;
        }
        if (policy.skipTimerWhenNoActionableWork &&`);
  const queueImports = imported("hasOpenRouterHourlyWait, limitOpenRouterAvailableSlots, triggerOpenRouterQueueDrain, withOpenRouterClaimLock");
  if (!output.queue.includes(queueImports)) {
    output.queue = queueImports + output.queue;
  }
  output.lifecycle = replaceOnce(output.lifecycle,
    'new Date(now.getTime() + (error ? 60_000 : 2_000)).toISOString()',
    'new Date(now.getTime() + (error ? (agent.adapterType === "openrouter" && agent.lifecycleState === "verifying" ? 3_600_000 : 60_000) : 2_000)).toISOString()');
  return output;
}

export function enforceOpenRouterRecovery(root = fileURLToPath(new URL("..", import.meta.url))) {
  const base = join(root, "node_modules", "@paperclipai");
  const files = {
    retries: join(base, "server", "dist", "services", "heartbeat", "retries.js"),
    completion: join(base, "server", "dist", "services", "heartbeat", "run-completion.js"),
    recovery: join(base, "server", "dist", "services", "recovery", "service.js"),
    pi: join(base, "adapter-pi-local", "dist", "server", "runtime-config.js"),
    piExecute: join(base, "adapter-pi-local", "dist", "server", "execute.js"),
    conversation: join(base, "server", "dist", "services", "conversation-continuation.js"),
    queue: join(base, "server", "dist", "services", "heartbeat", "queue.js"),
    lifecycle: join(base, "server", "dist", "modules", "agent-lifecycle", "adapters", "postgres.js"),
  };
  const sources = Object.fromEntries(Object.entries(files).map(([name, path]) => [name, readFileSync(path, "utf8")]));
  const patched = patchOpenRouterSources(sources);
  for (const [name, path] of Object.entries(files)) {
    if (patched[name] === sources[name]) continue;
    const temporary = `${path}.tmp-${process.pid}`;
    writeFileSync(temporary, patched[name], { mode: 0o644 });
    renameSync(temporary, path);
  }
  console.log("   Enforced free-only OpenRouter with persistent unlimited hourly retries.");
}
