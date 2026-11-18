import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export const OPENROUTER_RETRY_MS = 60 * 60 * 1000;

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
export async function reconcileOpenRouterRetries(db, deps, sql, logger) {
  if (!deps.scheduleRecoveryRetry) return;
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
  const result = await db.execute(sql`
    select r.id
    from heartbeat_runs r
    join agents a on a.id = r.agent_id and a.company_id = r.company_id
    left join issues i on i.id = r.issue_id and i.company_id = r.company_id
    where a.adapter_type = 'openrouter'
      and a.status not in ('paused', 'terminated', 'pending_approval')
      and r.status in ('failed', 'timed_out', 'interrupted')
      and coalesce(r.runtime_mode, 'local') <> 'native'
      and (r.runner_profile_json -> 'adapterDispatch' ->> 'adapterType' = 'openrouter'
        or exists (select 1 from heartbeat_run_events e
          where e.run_id = r.id and e.company_id = r.company_id
            and e.event_type = 'adapter.invoke' and e.payload ->> 'adapterType' = 'openrouter'))
      and coalesce(r.error_code, '') not in
        ('operator_interrupted', 'agent_paused', 'chat_control_stop', 'chat_control_unresolved')
      and (r.scope_kind = 'company' or (
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
      ))
      and not exists (
        select 1 from heartbeat_runs successor
        where successor.company_id = r.company_id and successor.retry_of_run_id = r.id
      )
      and not exists (
        select 1 from heartbeat_runs newer
        where newer.company_id = r.company_id
          and newer.scope_kind = r.scope_kind
          and (
            (r.scope_kind = 'issue' and newer.issue_id = r.issue_id)
            or (r.scope_kind = 'company' and newer.agent_id = r.agent_id
              and coalesce(newer.context_snapshot ->> 'taskKey', '') =
                  coalesce(r.context_snapshot ->> 'taskKey', ''))
          )
          and (newer.created_at, newer.id) > (r.created_at, r.id)
      )
      and not exists (
        select 1 from agent_task_sessions s
        where s.company_id = r.company_id and s.agent_id = r.agent_id
          and s.task_key = coalesce(r.issue_id::text, r.context_snapshot ->> 'taskKey')
          and s.goal_desired_state = 'paused'
      )
    order by r.created_at, r.id
    limit 200
  `);
  const rows = result.rows ?? result;
  if (!Array.isArray(rows)) throw new Error("Unexpected OpenRouter recovery query result.");
  for (const row of rows) {
    try {
      await deps.scheduleRecoveryRetry(row.id);
    } catch (error) {
      logger.error({ err: error, runId: row.id }, "OpenRouter hourly retry scheduling failed; the next sweep will retry");
    }
  }
}

function replaceOnce(source, before, after) {
  if (source.includes(after)) return source;
  if (source.split(before).length !== 2) {
    throw new Error(`OpenRouter recovery patch no longer matches upstream: ${before.slice(0, 100)}`);
  }
  return source.replace(before, after);
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
    'import { CONVERSATION_CONTINUATION_POLICY, hasConversationContinuationPolicy, historicalAdapterType, }');
  output.retries = replaceOnce(output.retries,
    '        const now = opts?.now ?? new Date();\n        const retryReason =',
    `        if (agent.adapterType === "openrouter" && await historicalAdapterType(db, run) === "openrouter") {
            run = { ...run, resultJson: { ...run.resultJson, conversationContinuation: CONVERSATION_CONTINUATION_POLICY } };
        }
        const now = opts?.now ?? new Date();
        const retryReason =`);
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
    'const requiresIssueGate = isTransientWorkspaceGitScanCode(run.errorCode) ||',
    'const requiresIssueGate = agent.adapterType === "openrouter" || isTransientWorkspaceGitScanCode(run.errorCode) ||');
  output.completion = replaceOnce(output.completion,
    'if (outcome === "failed" && isMaxTurnExhaustionRun(livenessRun)) {',
    'if (agent.adapterType === "openrouter" && ["failed", "timed_out", "interrupted"].includes(outcome)) {\n                await scheduleBoundedRetryForRun(livenessRun, agent);\n            }\n            else if (outcome === "failed" && isMaxTurnExhaustionRun(livenessRun)) {');
  output.completion = replaceOnce(output.completion,
    'await (isTransientWorkspaceGitScanCode(livenessRun.errorCode)',
    'await (failedAgent.adapterType === "openrouter" || isTransientWorkspaceGitScanCode(livenessRun.errorCode)');
  output.recovery = replaceOnce(output.recovery,
    '    async function reconcileStrandedAssignedIssues(opts) {',
    '    async function reconcileStrandedAssignedIssues(opts) {\n        await reconcileOpenRouterRetries(db, deps, sql, logger);');
  if (!output.recovery.includes(imported("reconcileOpenRouterRetries"))) {
    output.recovery = imported("reconcileOpenRouterRetries") + output.recovery;
  }
  output.recovery = replaceOnce(output.recovery,
    '            let latestRun = await getLatestIssueRun(issue.companyId, issue.id);',
    `            let latestRun = await getLatestIssueRun(issue.companyId, issue.id);
            if (latestRun && ["failed", "timed_out", "interrupted"].includes(latestRun.status) &&
                (await getAgent(latestRun.agentId))?.adapterType === "openrouter") {
                // The persistent hourly lane owns failures; never escalate them
                // or restart them via the generic 60-second continuation lane.
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
  output.conversation = replaceOnce(output.conversation,
    '    "pi_local", "grok_local", "kimi_local", "hermes_local",',
    '    "pi_local", "grok_local", "kimi_local", "hermes_local", "openrouter",');
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
  if (!output.queue.includes(imported("hasOpenRouterHourlyWait"))) {
    output.queue = imported("hasOpenRouterHourlyWait") + output.queue;
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
