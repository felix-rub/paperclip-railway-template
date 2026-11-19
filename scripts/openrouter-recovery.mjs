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

let queuedAgentCursor = 0;

export function orderQueuedAgentIds(agentIds) {
  const unique = [...new Set(agentIds)];
  if (unique.length <= 1) return unique;
  const offset = queuedAgentCursor % unique.length;
  queuedAgentCursor = (queuedAgentCursor + 1) % 1_000_000;
  return offset === 0 ? unique : [...unique.slice(offset), ...unique.slice(0, offset)];
}

export function openRouterQueuedRunClaimableSql(heartbeatRuns, sql) {
  return sql`not exists (
    select 1
    from issues target_issue
    where target_issue.company_id = ${heartbeatRuns.companyId}
      and target_issue.id = coalesce(
        case
          when (${heartbeatRuns.contextSnapshot} ->> 'issueId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then (${heartbeatRuns.contextSnapshot} ->> 'issueId')::uuid
          else null
        end,
        ${heartbeatRuns.issueId}
      )
      and target_issue.assignee_agent_id = ${heartbeatRuns.agentId}
      and coalesce(${heartbeatRuns.contextSnapshot} ->> 'wakeReason', '') <> 'source_scoped_recovery_action'
      and (
        (
          target_issue.origin_kind = 'routine_execution'
          and target_issue.origin_id is not null
          and target_issue.hidden_at is null
          and target_issue.status in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked')
          and exists (
            select 1
            from issues active_routine
            where active_routine.company_id = target_issue.company_id
              and active_routine.origin_kind = 'routine_execution'
              and active_routine.origin_id = target_issue.origin_id
              and active_routine.origin_fingerprint = target_issue.origin_fingerprint
              and active_routine.id <> target_issue.id
              and active_routine.hidden_at is null
              and active_routine.execution_run_id is not null
              and active_routine.status in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked')
          )
        )
        or (
          coalesce(${heartbeatRuns.scheduledRetryReason}, '') <> 'native_provider_overloaded'
          and target_issue.execution_run_id is not null
          and target_issue.execution_run_id <> ${heartbeatRuns.id}
          and exists (
            select 1
            from heartbeat_runs owner_run
            where owner_run.company_id = target_issue.company_id
              and owner_run.id = target_issue.execution_run_id
              and owner_run.status in ('queued', 'running', 'scheduled_retry')
          )
        )
      )
  )`;
}

export async function selectClaimableQueuedRuns(db, agent, heartbeatRuns, ops) {
  const { cutoff, and, asc, eq, gte, inArray, sql } = ops;
  if (agent?.adapterType !== "openrouter") {
    return db
      .select()
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.agentId, agent.id),
        eq(heartbeatRuns.status, "queued"),
        cutoff ? gte(heartbeatRuns.createdAt, cutoff) : undefined,
        openRouterQueuedRunClaimableSql(heartbeatRuns, sql),
      ))
      .orderBy(asc(heartbeatRuns.createdAt));
  }
  const cutoffFilter = cutoff ? sql`and r.created_at >= ${cutoff}` : sql``;
  const candidateResult = await db.execute(sql`
    with claimable as (
      select
        r.id,
        r.created_at,
        case
          when i.id is null then 2
          when i.status = 'in_progress' then 0
          else 1
        end as status_rank,
        case i.priority
          when 'critical' then 0
          when 'high' then 1
          when 'medium' then 2
          when 'low' then 3
          else 4
        end as priority_rank,
        row_number() over (
          partition by case
            when i.origin_kind = 'routine_execution' and i.origin_id is not null
              then 'routine:' || i.origin_id || ':' || coalesce(i.origin_fingerprint, 'default')
            when i.id is not null
              and coalesce(r.context_snapshot ->> 'wakeCommentId', '') = ''
              and jsonb_typeof(r.context_snapshot -> 'wakeCommentIds') is distinct from 'array'
              then 'issue:' || i.id::text
            else 'run:' || r.id::text
          end
          order by r.created_at asc
        ) as group_rn
      from heartbeat_runs r
      left join issues i
        on i.company_id = r.company_id
       and i.id = coalesce(
         case
           when (r.context_snapshot ->> 'issueId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           then (r.context_snapshot ->> 'issueId')::uuid
           else null
         end,
         r.issue_id
       )
      where r.agent_id = ${agent.id}
        and r.company_id = ${agent.companyId}
        and r.status = 'queued'
        ${cutoffFilter}
        and not (
          i.id is not null
          and i.assignee_agent_id = r.agent_id
          and coalesce(r.context_snapshot ->> 'wakeReason', '') <> 'source_scoped_recovery_action'
          and (
            (
              i.origin_kind = 'routine_execution'
              and i.origin_id is not null
              and i.hidden_at is null
              and i.status in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked')
              and exists (
                select 1
                from issues active_routine
                where active_routine.company_id = i.company_id
                  and active_routine.origin_kind = 'routine_execution'
                  and active_routine.origin_id = i.origin_id
                  and active_routine.origin_fingerprint = i.origin_fingerprint
                  and active_routine.id <> i.id
                  and active_routine.hidden_at is null
                  and active_routine.execution_run_id is not null
                  and active_routine.status in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked')
              )
            )
            or (
              coalesce(r.scheduled_retry_reason, '') <> 'native_provider_overloaded'
              and i.execution_run_id is not null
              and i.execution_run_id <> r.id
              and exists (
                select 1
                from heartbeat_runs owner_run
                where owner_run.company_id = i.company_id
                  and owner_run.id = i.execution_run_id
                  and owner_run.status in ('queued', 'running', 'scheduled_retry')
              )
            )
          )
        )
    )
    select id
    from claimable
    where group_rn <= 3
    order by status_rank asc, priority_rank asc, created_at asc
    limit 50
  `);
  const candidateRows = candidateResult.rows ?? candidateResult;
  if (!Array.isArray(candidateRows) || candidateRows.length === 0) return [];
  const candidateIds = candidateRows.map((row) => row.id).filter(Boolean);
  if (candidateIds.length === 0) return [];
  return db
    .select()
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.agentId, agent.id),
      eq(heartbeatRuns.status, "queued"),
      inArray(heartbeatRuns.id, candidateIds),
    ))
    .orderBy(asc(heartbeatRuns.createdAt));
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

const bootUnparkedDbs = new WeakSet();
const stateLogTimestamps = new WeakMap();
const STATE_LOG_INTERVAL_MS = 5 * 60_000;

export async function reconcileOpenRouterAgentReadiness(db, deps, sql, logger) {
  if (typeof deps?.scheduleAgentLifecycle !== "function") {
    return { healedAgents: 0, resumedAgents: 0, unparkedAgents: 0 };
  }
  const isFirstBootSweep = typeof db === "object" && db !== null && !bootUnparkedDbs.has(db);
  const healedRes = await db.execute(sql`
    update agents a
    set status = 'idle',
        pause_reason = null,
        paused_at = null,
        updated_at = now()
    from companies c
    where c.id = a.company_id
      and c.status = 'active'
      and a.adapter_type = 'openrouter'
      and a.lifecycle_state = 'ready'
      and coalesce(a.lifecycle_holds, '[]'::jsonb) = '[]'::jsonb
      and a.status in ('paused', 'error')
    returning a.id
  `);
  const healedRows = healedRes.rows ?? healedRes;
  const healedAgents = Array.isArray(healedRows) ? healedRows.length : 0;

  let resumedAgents = 0;
  if (typeof deps?.reconcileAgentLifecycle === "function") {
    const pausedRes = await db.execute(sql`
      select a.id
      from agents a
      join companies c on c.id = a.company_id and c.status = 'active'
      where a.adapter_type = 'openrouter'
        and a.lifecycle_state = 'paused'
        and coalesce(a.lifecycle_holds, '[]'::jsonb) = '[]'::jsonb
    `);
    const pausedRows = pausedRes.rows ?? pausedRes;
    if (Array.isArray(pausedRows)) {
      for (const row of pausedRows) {
        try {
          await deps.reconcileAgentLifecycle(db, row.id);
          resumedAgents += 1;
        } catch (error) {
          logger?.error?.({ err: error, agentId: row.id }, "OpenRouter paused agent lifecycle reconcile failed");
        }
      }
    }
  }

  const unparkRes = await db.execute(sql`
    update agents a
    set lifecycle_error = null,
        lifecycle_operation = coalesce(a.lifecycle_operation, '{}'::jsonb)
          - 'retryAt' - 'retryRequired' - 'verificationFailures'
          - 'leaseOwner' - 'leaseUntil' - 'leaseHolder'
          - 'waitingForSignal' - 'recheckRequested',
        updated_at = now()
    from companies c
    where c.id = a.company_id
      and c.status = 'active'
      and a.adapter_type = 'openrouter'
      and a.lifecycle_state in ('verifying', 'preparing', 'resuming')
      and not (coalesce(a.lifecycle_holds, '[]'::jsonb) @> '["setup"]'::jsonb)
      and coalesce((a.lifecycle_operation->>'leaseUntil')::timestamptz, '-infinity') <= now()
      and (
        coalesce(a.lifecycle_operation->>'retryRequired', 'false') = 'true'
        or coalesce(a.lifecycle_operation->>'waitingForSignal', 'false') = 'true'
        or (${isFirstBootSweep} and a.lifecycle_state = 'verifying' and coalesce((a.lifecycle_operation->>'retryAt')::timestamptz, '-infinity') > now())
      )
    returning a.id
  `);
  if (isFirstBootSweep) {
    bootUnparkedDbs.add(db);
  }
  const unparkRows = unparkRes.rows ?? unparkRes;
  let unparkedAgents = 0;
  if (Array.isArray(unparkRows)) {
    for (const row of unparkRows) {
      try {
        await deps.scheduleAgentLifecycle(db, row.id);
        unparkedAgents += 1;
      } catch (error) {
        logger?.error?.({ err: error, agentId: row.id }, "OpenRouter lifecycle reschedule failed");
      }
    }
  }
  return { healedAgents, resumedAgents, unparkedAgents, isFirstBootSweep };
}

// The ordinary retry service owns locks, authorization, session inheritance and
// successor deduplication. This sweep only recovers terminal work it missed.
export async function reconcileOpenRouterRetries(db, deps, sql, logger, opts = {}) {
  if (!deps.scheduleRecoveryRetry) return { selected: 0, scheduled: 0 };
  const limit = Number.isSafeInteger(opts?.limit) && opts.limit > 0 ? opts.limit : DEFAULT_DIRECT_SWEEP_LIMIT;
  const readiness = await reconcileOpenRouterAgentReadiness(db, deps, sql, logger);
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
  if (typeof deps?.scheduleAgentLifecycle === "function") {
    try {
      const summaryRes = await db.execute(sql`
        select
          (select count(*)::int from agents a join companies c on c.id = a.company_id and c.status = 'active'
            where a.adapter_type = 'openrouter' and a.lifecycle_state = 'ready' and a.status not in ('paused', 'terminated', 'pending_approval')) as ready_agents,
          (select count(*)::int from agents a join companies c on c.id = a.company_id and c.status = 'active'
            where a.adapter_type = 'openrouter' and a.lifecycle_state = 'verifying') as verifying_agents,
          (select count(*)::int from agents a join companies c on c.id = a.company_id and c.status = 'active'
            where a.adapter_type = 'openrouter' and (a.lifecycle_state = 'paused' or a.status = 'paused')) as paused_agents,
          (select count(*)::int from heartbeat_runs r join agents a on a.id = r.agent_id and a.company_id = r.company_id join companies c on c.id = r.company_id and c.status = 'active'
            where a.adapter_type = 'openrouter' and r.status = 'running') as running_runs,
          (select count(*)::int from heartbeat_runs r join agents a on a.id = r.agent_id and a.company_id = r.company_id join companies c on c.id = r.company_id and c.status = 'active'
            where a.adapter_type = 'openrouter' and r.status = 'queued') as queued_runs,
          (select count(*)::int from heartbeat_runs r join agents a on a.id = r.agent_id and a.company_id = r.company_id join companies c on c.id = r.company_id and c.status = 'active'
            where a.adapter_type = 'openrouter' and r.status = 'scheduled_retry') as scheduled_retry_runs
      `);
      const summaryRow = (summaryRes.rows ?? summaryRes)?.[0] ?? {};
      const readyAgents = Number(summaryRow.ready_agents ?? 0);
      const verifyingAgents = Number(summaryRow.verifying_agents ?? 0);
      const pausedAgents = Number(summaryRow.paused_agents ?? 0);
      const runningRuns = Number(summaryRow.running_runs ?? 0);
      const queuedRuns = Number(summaryRow.queued_runs ?? 0);
      const scheduledRetryRuns = Number(summaryRow.scheduled_retry_runs ?? 0);
      if (readyAgents > 0 && queuedRuns > 0 && runningRuns < resolveOpenRouterMaxConcurrentRuns()) {
        await deps.notifyQueuedRunDispatch?.(db);
      }
      const now = Date.now();
      const lastLoggedAt = stateLogTimestamps.get(db) ?? 0;
      const changed = (readiness.healedAgents + readiness.resumedAgents + readiness.unparkedAgents + scheduled) > 0;
      if (readiness.isFirstBootSweep || changed || now - lastLoggedAt >= STATE_LOG_INTERVAL_MS) {
        stateLogTimestamps.set(db, now);
        logger?.info?.({
          tag: "openrouter.reconcile.state",
          readyAgents,
          verifyingAgents,
          pausedAgents,
          runningRuns,
          queuedRuns,
          scheduledRetryRuns,
          unparkedAgents: readiness.unparkedAgents,
          healedAgents: readiness.healedAgents,
          resumedAgents: readiness.resumedAgents,
          scheduledRetries: scheduled,
        }, "OpenRouter readiness and retry state");
      }
    } catch (error) {
      logger?.error?.({ err: error }, "OpenRouter readiness summary failed");
    }
  }
  return { selected: rows.length, scheduled, ...readiness };
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
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const normalize = value => value.replace(/\r\n/g, "\n").replace(/\n/g, eol);
  const befores = (Array.isArray(before) ? before : [before]).map(normalize);
  const afters = (Array.isArray(after) ? after : [after]).map(normalize);
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
    'import { notifyScheduledRetryDispatch } from "../run-dispatch-notifications.js";',
    'import { notifyQueuedRunDispatch, notifyScheduledRetryDispatch } from "../run-dispatch-notifications.js";');
  output.recovery = replaceOnce(output.recovery,
    'import { isAgentAwaitingSetup } from "../../modules/agent-lifecycle/index.js";',
    'import { isAgentAwaitingSetup, reconcileAgentLifecycle, scheduleAgentLifecycle } from "../../modules/agent-lifecycle/index.js";\nimport { runUsedConversationAdapter } from "../conversation-continuation.js";');
  output.recovery = replaceOnce(output.recovery,
    '    async function reconcileStrandedAssignedIssues(opts) {',
    '    async function reconcileStrandedAssignedIssues(opts) {\n        scheduleOpenRouterRetrySweep(db, { ...deps, reconcileAgentLifecycle, scheduleAgentLifecycle, notifyQueuedRunDispatch }, sql, logger);');
  if (!output.recovery.includes(imported("scheduleOpenRouterRetrySweep"))) {
    output.recovery = imported("scheduleOpenRouterRetrySweep") + output.recovery;
  }
  output.recovery = replaceOnce(output.recovery,
    '            let latestRun = await getLatestIssueRun(issue.companyId, issue.id);',
    `            let latestRun = await getLatestIssueRun(issue.companyId, issue.id);
            if (latestRun && latestRun.agentId === agentId &&
                ["failed", "timed_out", "interrupted"].includes(latestRun.status) &&
                (await getAgent(agentId))?.adapterType === "openrouter") {
                const [fullLatestRun] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, issue.companyId), eq(heartbeatRuns.id, latestRun.id)));
                if (fullLatestRun && (await runUsedConversationAdapter(db, fullLatestRun) ||
                    fullLatestRun.resultJson?.executionRecovery?.providerWorkStarted === false)) {
                    // The persistent hourly lane owns conversation/bootstrap failures; never
                    // escalate them or restart them via the generic 60-second continuation lane.
                    result.skipped += 1;
                    continue;
                }
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
    `        const queuedRuns = await db
            .select({ agentId: heartbeatRuns.agentId })
            .from(heartbeatRuns)
            .innerJoin(companies, eq(companies.id, heartbeatRuns.companyId))
            .where(and(eq(heartbeatRuns.status, "queued"), scope ? eq(heartbeatRuns.companyId, scope.companyId) : undefined, eq(companies.status, "active"), cutoff ? gte(heartbeatRuns.createdAt, cutoff) : undefined));
        const agentIds = [...new Set(queuedRuns.map((r) => r.agentId))];`,
    `        const queuedRuns = await db
            .selectDistinct({ agentId: heartbeatRuns.agentId })
            .from(heartbeatRuns)
            .innerJoin(companies, eq(companies.id, heartbeatRuns.companyId))
            .where(and(eq(heartbeatRuns.status, "queued"), scope ? eq(heartbeatRuns.companyId, scope.companyId) : undefined, eq(companies.status, "active"), cutoff ? gte(heartbeatRuns.createdAt, cutoff) : undefined, openRouterQueuedRunClaimableSql(heartbeatRuns, sql)));
        const agentIds = orderQueuedAgentIds(queuedRuns.map((r) => r.agentId));`);
  output.queue = replaceOnce(output.queue,
    `                or coalesce(prior.continuation_attempt, 0) > 0)))
          )\`));
        for (const { agentId } of rows) {
            await startNextQueuedRunForAgent(agentId);
        }`,
    `                or coalesce(prior.continuation_attempt, 0) > 0)))
          )\`, openRouterQueuedRunClaimableSql(heartbeatRuns, sql)));
        for (const agentId of orderQueuedAgentIds(rows.map((r) => r.agentId))) {
            await startNextQueuedRunForAgent(agentId);
        }`);
  output.queue = replaceOnce(output.queue,
    `            const policy = parseHeartbeatPolicy(agent);
            const runningCount = await countRunningRunsForAgent(agentId);
            const availableSlots = Math.max(0, policy.maxConcurrentRuns - runningCount);
            if (availableSlots <= 0)
                return [];
            const queuedRuns = await db
                .select()
                .from(heartbeatRuns)
                .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "queued"), cutoff ? gte(heartbeatRuns.createdAt, cutoff) : undefined))
                .orderBy(asc(heartbeatRuns.createdAt));`,
    `            const policy = parseHeartbeatPolicy(agent);
            const runningCount = await countRunningRunsForAgent(agentId);
            const perAgentSlots = Math.max(0, policy.maxConcurrentRuns - runningCount);
            const availableSlots = await limitOpenRouterAvailableSlots(db, agent, perAgentSlots, sql);
            if (availableSlots <= 0)
                return [];
            const queuedRuns = await selectClaimableQueuedRuns(db, agent, heartbeatRuns, { cutoff, and, asc, eq, gte, inArray, sql });`);
  output.queue = replaceOnce(output.queue,
    `            const issueRows = await db
                .select({
                id: issues.id,
                status: issues.status,
                priority: issues.priority,
            })`,
    `            const issueRows = await db
                .select({
                id: issues.id,
                status: issues.status,
                priority: issues.priority,
                originKind: issues.originKind,
                originId: issues.originId,
                originFingerprint: issues.originFingerprint,
            })`);
  output.queue = replaceOnce(output.queue,
    `            const claimedRuns = [];
            for (const queuedRun of prioritizedRuns) {
                if (claimedRuns.length >= availableSlots)
                    break;
                let claimed;
                try {
                    claimed = await claimQueuedRun(queuedRun, companyAgents, deferredPostCommitEffects, deferredCancellations);
                }
                catch (err) {
                    if (isPermanentClaimRejection(err)) {
                        rejectedClaims.push({ run: queuedRun, err });
                        continue;
                    }
                    if (!isDeferrableClaimRejection(err))
                        throw err;
                    logger.warn({ err, runId: queuedRun.id, agentId: queuedRun.agentId, companyId: queuedRun.companyId }, "queued heartbeat run claim was rejected; leaving it queued for the next recovery pass");
                    continue;
                }
                if (claimed)
                    claimedRuns.push(claimed);
            }`,
    `            const claimedRuns = await withOpenRouterClaimLock(agent, async () => {
                const lockedSlots = await limitOpenRouterAvailableSlots(db, agent, Math.max(0, policy.maxConcurrentRuns - await countRunningRunsForAgent(agentId)), sql);
                if (lockedSlots <= 0)
                    return [];
                const batch = [];
                const skippedRoutineKeys = new Set();
                for (const queuedRun of prioritizedRuns) {
                    if (batch.length >= lockedSlots)
                        break;
                    const runIssueId = readNonEmptyString(parseObject(queuedRun.contextSnapshot).issueId);
                    const runIssue = runIssueId ? issueById.get(runIssueId) : null;
                    const routineKey = runIssue?.originKind === "routine_execution" && runIssue.originId
                        ? \`\${runIssue.originId}:\${runIssue.originFingerprint ?? "default"}\`
                        : null;
                    if (routineKey && skippedRoutineKeys.has(routineKey))
                        continue;
                    let claimed;
                    try {
                        claimed = await claimQueuedRun(queuedRun, companyAgents, deferredPostCommitEffects, deferredCancellations);
                    }
                    catch (err) {
                        if (isPermanentClaimRejection(err)) {
                            rejectedClaims.push({ run: queuedRun, err });
                            continue;
                        }
                        if (!isDeferrableClaimRejection(err))
                            throw err;
                        if (routineKey && err.status === 409)
                            skippedRoutineKeys.add(routineKey);
                        logger.warn({ err, runId: queuedRun.id, agentId: queuedRun.agentId, companyId: queuedRun.companyId }, "queued heartbeat run claim was rejected; leaving it queued for the next recovery pass");
                        continue;
                    }
                    if (claimed) {
                        batch.push(claimed);
                        if (routineKey)
                            skippedRoutineKeys.add(routineKey);
                    }
                }
                return batch;
            });`);
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
  const queueImports = imported("hasOpenRouterHourlyWait, limitOpenRouterAvailableSlots, openRouterQueuedRunClaimableSql, orderQueuedAgentIds, selectClaimableQueuedRuns, triggerOpenRouterQueueDrain, withOpenRouterClaimLock");
  if (!output.queue.includes(queueImports)) {
    output.queue = queueImports + output.queue;
  }
  output.lifecycle = replaceOnce(output.lifecycle,
    'const retry = options?.retryRequired && agent.lifecycleState === "verifying"',
    'const retry = options?.retryRequired && agent.lifecycleState === "verifying" && agent.adapterType !== "openrouter"');
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
