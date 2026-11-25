import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export const OPENROUTER_RETRY_MS = 60 * 60 * 1000;
const FREE_AGENT_CONFIG_REMOVED_KEYS = [
  "provider", "acpxAgent", "fallbackModels", "escalationModel", "apiKey",
  "baseUrl", "command", "args", "extraArgs", "aiConnection",
];

export function normalizeFreeAgentConfiguration(input, existing = {}) {
  const adapterConfig = { ...(input.adapterConfig ?? existing.adapterConfig ?? {}) };
  for (const key of FREE_AGENT_CONFIG_REMOVED_KEYS) delete adapterConfig[key];
  adapterConfig.model = "openrouter/free";
  const runtimeConfig = { ...(input.runtimeConfig ?? existing.runtimeConfig ?? {}) };
  delete runtimeConfig.aiConnection;
  return { ...input, adapterType: "openrouter", adapterConfig, runtimeConfig };
}

const freeAgentPolicyInstalled = new WeakSet();

export async function enforceFreeAgentDefaults(db, sql, logger) {
  if (freeAgentPolicyInstalled.has(db)) return;
  // The trigger also covers portability imports and writes outside the hiring API.
  await db.execute(sql.raw(`
    create or replace function paperclip_free_agent_config(config jsonb) returns jsonb
    language sql immutable as $policy$
      select (coalesce(config, '{}'::jsonb) - array[${FREE_AGENT_CONFIG_REMOVED_KEYS.map(key => `'${key}'`).join(",")}]::text[])
        || '{"model":"openrouter/free"}'::jsonb
    $policy$;
  `));
  await db.execute(sql.raw(`
    create or replace function paperclip_enforce_free_agent() returns trigger
    language plpgsql as $policy$
    begin
      new.adapter_type := 'openrouter';
      new.adapter_config := paperclip_free_agent_config(new.adapter_config);
      new.runtime_config := coalesce(new.runtime_config, '{}'::jsonb) - 'aiConnection';
      return new;
    end
    $policy$;
  `));
  await db.execute(sql.raw(`
    create or replace trigger paperclip_free_agent_defaults
    before insert or update of adapter_type, adapter_config, runtime_config on agents
    for each row execute function paperclip_enforce_free_agent();
  `));
  const repaired = await db.execute(sql`
    update agents a
    set adapter_type = 'openrouter',
        adapter_config = paperclip_free_agent_config(a.adapter_config),
        runtime_config = coalesce(a.runtime_config, '{}'::jsonb) - 'aiConnection',
        updated_at = now()
    from companies c
    where c.id = a.company_id and c.status <> 'archived' and a.status <> 'terminated'
      and (a.adapter_type <> 'openrouter'
        or a.adapter_config is distinct from paperclip_free_agent_config(a.adapter_config)
        or a.runtime_config ? 'aiConnection')
    returning a.id, a.company_id
  `);
  const inventory = await db.execute(sql`
    select c.id as company_id, c.name as company_name, count(*)::int as agents,
      count(*) filter (where a.adapter_type = 'openrouter'
        and a.adapter_config->>'model' = 'openrouter/free'
        and not (a.runtime_config ? 'aiConnection'))::int as free_agents
    from companies c join agents a on a.company_id = c.id
    where c.status <> 'archived' and a.status <> 'terminated'
    group by c.id, c.name order by c.name
  `);
  const rows = inventory.rows ?? inventory;
  if (!Array.isArray(rows) || rows.some(row => row.agents !== row.free_agents)) {
    throw new Error("Free agent defaults verification failed");
  }
  logger?.info?.({
    tag: "openrouter.agent_defaults",
    repairedAgents: (repaired.rows ?? repaired).length,
    companies: rows,
  }, "Verified persisted free-only agent defaults across organizations");
  freeAgentPolicyInstalled.add(db);
}

export const DEFAULT_OPENROUTER_MAX_CONCURRENT_RUNS = 4;
const OPENROUTER_QUOTA_THROTTLE_FAILURES = 3;
const DEFAULT_SWEEP_BATCH_LIMIT = 25;
const DEFAULT_DIRECT_SWEEP_LIMIT = 200;
const DEFAULT_SWEEP_INITIAL_DELAY_MS = 2_000;
const DEFAULT_SWEEP_CONTINUATION_DELAY_MS = 2_000;
const DEFAULT_SWEEP_MIN_INTERVAL_MS = 60_000;
export const OBSOLETE_ROUTINE_IDS = [
  "637646eb-ec76-4ade-b375-8be0eea94a78",
  "c360cccc-2de7-465e-9073-5f28565dc064",
  "e8c2dbe3-0a57-4a0c-b527-ef9a36de63b5",
  "23deafef-15aa-4b13-bace-1bba09b553e8",
  "e5c0612a-68ab-42eb-9b36-347ed36d7662",
];
const RETIRED_DAILY_ROUTINE_IDS = [
  "5cdb030a-715b-49a3-9b38-519ac7a8446e",
  "45e6e1a1-fdf3-4c38-a543-fbd2d9632e40",
  "ee5619a5-c8d6-4cf8-a4a9-4214c1770dcb",
  "0b990ff4-33fb-4f35-b4c8-99f2e630377b",
  "58742868-1027-4e26-80ff-9ded26e7b236",
  "0898de2f-0298-4be6-8b3b-a6542b60267c",
  "c1c52c3b-a3cd-41f9-8fd8-5420aacb51e3",
  "166f9031-9fd1-4d7c-b625-c58ec2adaa82",
  "bed9b44b-63c6-4b3d-badb-3b7f89547049",
];

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

export function freePoolExhaustedUntil(now = Date.now()) {
  const until = Number(globalThis[Symbol.for("paperclip.freePool")]?.exhaustedUntil?.() ?? 0);
  return Number.isFinite(until) && until > now ? until : 0;
}

export async function limitOpenRouterAvailableSlots(db, agent, availableSlots, sql, env = process.env) {
  if (agent?.adapterType !== "openrouter" || availableSlots <= 0) return availableSlots;
  // Every free lane is cooling down: keep queued runs queued instead of burning
  // them on guaranteed quota failures. The sweep re-dispatches once a lane reopens.
  if (freePoolExhaustedUntil()) return 0;
  const configuredMax = resolveOpenRouterMaxConcurrentRuns(env);
  const result = await db.execute(sql`
    select
      (
        select count(*)::int
        from heartbeat_runs r
        join agents a on a.id = r.agent_id and a.company_id = r.company_id
        where r.status = 'running' and a.adapter_type = 'openrouter'
      ) as running_global,
      (
        select count(distinct r.company_id)::int
        from heartbeat_runs r
        join agents a on a.id = r.agent_id and a.company_id = r.company_id
        join companies c on c.id = r.company_id and c.status = 'active'
        where r.status = 'queued' and a.adapter_type = 'openrouter'
      ) as queued_companies,
      (
        select count(*)::int
        from heartbeat_runs r
        join agents a on a.id = r.agent_id and a.company_id = r.company_id
        where r.status = 'running'
          and a.adapter_type = 'openrouter'
          and r.company_id = ${agent.companyId}
      ) as running_company,
      (
        select count(distinct queued.company_id)::int
        from heartbeat_runs queued
        join agents a on a.id = queued.agent_id and a.company_id = queued.company_id
        join companies c on c.id = queued.company_id and c.status = 'active'
        where queued.status = 'queued'
          and a.adapter_type = 'openrouter'
          and queued.company_id <> ${agent.companyId}
          and not exists (
            select 1
            from heartbeat_runs running
            join agents running_agent
              on running_agent.id = running.agent_id
             and running_agent.company_id = running.company_id
            where running.company_id = queued.company_id
              and running.status = 'running'
              and running_agent.adapter_type = 'openrouter'
          )
      ) as unserved_other_companies,
      (
        select count(*)::int
        from heartbeat_runs r
        join agents a on a.id = r.agent_id and a.company_id = r.company_id
        where r.status in ('failed', 'timed_out', 'interrupted')
          and a.adapter_type = 'openrouter'
          and r.finished_at > now() - interval '10 minutes'
          and (
            coalesce(r.error, '') ~* '(429|rate limit|high demand|free-models-per-day|quota)'
            or coalesce(r.error_code, '') = 'native_provider_overloaded'
          )
      ) as recent_quota_failures
  `);
  const rows = result.rows ?? result;
  if (!Array.isArray(rows)) throw new Error("Unexpected OpenRouter concurrency query result.");
  const row = rows[0] ?? {};
  const runningGlobal = Number(row.running_global ?? row.count ?? 0);
  const queuedCompanies = Number(row.queued_companies ?? 0);
  const runningCompany = Number(row.running_company ?? 0);
  const unservedOthers = Number(row.unserved_other_companies ?? 0);
  const recentQuotaFailures = Number(row.recent_quota_failures ?? 0);
  const minimumPerCompanyCap = Math.max(queuedCompanies, 1);
  const effectiveGlobalMax = recentQuotaFailures >= OPENROUTER_QUOTA_THROTTLE_FAILURES
    ? minimumPerCompanyCap
    : Math.max(configuredMax, minimumPerCompanyCap);
  if (runningCompany > 0 && unservedOthers > 0) return 0;
  return Math.max(0, Math.min(availableSlots, effectiveGlobalMax - runningGlobal));
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
let queuedCompanyCursor = 0;
const queuedAgentCursors = new Map();

export function orderQueuedAgentIds(agentIds) {
  const unique = [...new Set(agentIds)];
  if (unique.length <= 1) return unique;
  const offset = queuedAgentCursor % unique.length;
  queuedAgentCursor = (queuedAgentCursor + 1) % 1_000_000;
  return offset === 0 ? unique : [...unique.slice(offset), ...unique.slice(0, offset)];
}

export function orderQueuedAgents(rows) {
  const byCompany = new Map();
  for (const row of rows ?? []) {
    if (!row?.agentId || !row?.companyId) continue;
    const agents = byCompany.get(row.companyId) ?? new Set();
    agents.add(row.agentId);
    byCompany.set(row.companyId, agents);
  }
  const companies = [...byCompany.keys()].sort();
  if (companies.length === 0) {
    return orderQueuedAgentIds((rows ?? []).map(row => row?.agentId).filter(Boolean));
  }
  const companyOffset = queuedCompanyCursor % companies.length;
  queuedCompanyCursor = (queuedCompanyCursor + 1) % 1_000_000;
  const orderedCompanies = [...companies.slice(companyOffset), ...companies.slice(0, companyOffset)];
  const queues = orderedCompanies.map(companyId => {
    const agents = [...byCompany.get(companyId)].sort();
    const cursor = queuedAgentCursors.get(companyId) ?? 0;
    const offset = cursor % agents.length;
    queuedAgentCursors.set(companyId, (cursor + 1) % 1_000_000);
    return [...agents.slice(offset), ...agents.slice(0, offset)];
  });
  const ordered = [];
  const maxAgents = Math.max(...queues.map(queue => queue.length));
  for (let index = 0; index < maxAgents; index += 1) {
    for (const queue of queues) {
      if (queue[index]) ordered.push(queue[index]);
    }
  }
  return ordered;
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

export async function listOpenRouterQueue(db, companyId, sql) {
  const result = await db.execute(sql`
    with candidates as (
      select
        r.id,
        r.company_id,
        r.agent_id,
        a.name as agent_name,
        r.status,
        r.created_at,
        r.started_at,
        r.scheduled_retry_at,
        r.issue_id,
        i.identifier as issue_identifier,
        i.title as issue_title,
        case r.status
          when 'running' then 0
          when 'queued' then 1
          else 2
        end as state_rank,
        case i.priority
          when 'critical' then 0
          when 'high' then 1
          when 'medium' then 2
          when 'low' then 3
          else 4
        end as priority_rank
      from heartbeat_runs r
      join agents a on a.id = r.agent_id and a.company_id = r.company_id
      left join issues i on i.company_id = r.company_id
        and i.id::text = nullif(coalesce(r.issue_id::text, r.context_snapshot ->> 'issueId'), '')
      where r.company_id = ${companyId}
        and a.adapter_type = 'openrouter'
        and r.status in ('queued', 'running', 'scheduled_retry')
    ),
    ordered as (
      select c.*,
        row_number() over (
          order by c.state_rank, c.priority_rank,
            coalesce(c.scheduled_retry_at, c.created_at), c.created_at, c.id
        )::int as overall_position,
        row_number() over (
          partition by c.agent_id
          order by c.state_rank, c.priority_rank,
            coalesce(c.scheduled_retry_at, c.created_at), c.created_at, c.id
        )::int as agent_position,
        (
          select coalesce(
            percentile_cont(0.5) within group (
              order by extract(epoch from (finished_at - started_at)) * 1000
            ),
            300000
          )::int
          from heartbeat_runs duration
          where duration.company_id = ${companyId}
            and duration.agent_id = c.agent_id
            and duration.status = 'succeeded'
            and duration.started_at is not null
            and duration.finished_at is not null
            and duration.finished_at > now() - interval '24 hours'
        ) as median_duration_ms
      from candidates c
    )
    select * from ordered
    order by overall_position
  `);
  const rows = result.rows ?? result;
  if (!Array.isArray(rows)) throw new Error("Unexpected OpenRouter queue query result.");
  const cooldownUntil = freePoolExhaustedUntil();
  const runningCount = rows.filter(row => row.status === "running").length;
  const queuePositions = new Map();
  const agentPositions = new Map();
  const agentCounts = new Map();
  for (const row of rows) {
    if (row.status === "running") continue;
    queuePositions.set(row.id, queuePositions.size + 1);
    const next = (agentCounts.get(row.agent_id) ?? 0) + 1;
    agentCounts.set(row.agent_id, next);
    agentPositions.set(row.id, next);
  }
  return {
    generatedAt: new Date().toISOString(),
    workerCount: resolveOpenRouterMaxConcurrentRuns(),
    runningCount,
    quotaCooldownUntil: cooldownUntil ? new Date(cooldownUntil).toISOString() : null,
    queuedCount: rows.filter(row => row.status !== "running").length,
    runs: rows.map(row => ({
      id: row.id,
      companyId: row.company_id,
      agentId: row.agent_id,
      agentName: row.agent_name,
      status: row.status,
      position: row.status === "running" ? 0 : Number(queuePositions.get(row.id) ?? 0),
      agentPosition: row.status === "running" ? 0 : Number(agentPositions.get(row.id) ?? 0),
      queuedAt: row.created_at,
      startedAt: row.started_at,
      scheduledRetryAt: row.scheduled_retry_at,
      issueId: row.issue_id,
      issueIdentifier: row.issue_identifier,
      issueTitle: row.issue_title,
      medianDurationMs: Number(row.median_duration_ms ?? 300_000),
    })),
  };
}

const bootUnparkedDbs = new WeakSet();
const stateLogTimestamps = new WeakMap();
const STATE_LOG_INTERVAL_MS = 5 * 60_000;

export async function reconcileOpenRouterControlPlane(db, sql, logger) {
  await enforceFreeAgentDefaults(db, sql, logger);
  const detachedRes = await db.execute(sql`
    with stale_detached as (
      update heartbeat_runs r
      set status = 'interrupted',
          finished_at = coalesce(r.finished_at, now()),
          updated_at = now()
      from agents a, companies c
      where a.id = r.agent_id
        and a.company_id = r.company_id
        and c.id = r.company_id
        and c.status = 'active'
        and a.adapter_type = 'openrouter'
        and r.status = 'running'
        and r.error_code = 'process_detached'
        and r.error like '%different_process_space%'
        and coalesce(r.process_started_at, r.updated_at, r.created_at) < now() - interval '10 minutes'
      returning r.id, r.company_id, r.agent_id, r.wakeup_request_id, r.error
    ),
    cancel_wakeups as (
      update agent_wakeup_requests w
      set status = 'cancelled',
          error = coalesce(w.error, 'Recovered detached OpenRouter process ownership'),
          finished_at = coalesce(w.finished_at, now()),
          updated_at = now()
      from stale_detached s
      where (w.id = s.wakeup_request_id or w.run_id = s.id)
        and w.status in ('queued', 'claimed', 'deferred_issue_execution')
      returning w.id
    )
    select id, company_id, agent_id, error from stale_detached
  `);
  const detachedRuns = detachedRes.rows ?? detachedRes;
  if (Array.isArray(detachedRuns)) {
    for (const run of detachedRuns) {
      logger?.info?.({
        tag: "openrouter.reconcile.detached_run",
        companyId: run.company_id,
        agentId: run.agent_id,
        runId: run.id,
        reason: run.error,
      }, "Recovered stale detached OpenRouter run");
    }
  }
  const policyRes = await db.execute(sql`
    update budget_policies p
    set amount = greatest(p.amount, 10000),
        hard_stop_enabled = false,
        unpriced_usage_policy = 'allow',
        is_active = true,
        updated_at = now()
    from companies c
    where c.id = p.company_id and c.status = 'active'
      and (
        p.amount < 10000 or p.hard_stop_enabled
        or p.unpriced_usage_policy is distinct from 'allow' or not p.is_active
      )
    returning p.id
  `);
  await db.execute(sql`
    insert into budget_policies (
      company_id, scope_type, scope_id, metric, window_kind, amount,
      hard_stop_enabled, unpriced_usage_policy, notify_enabled, is_active
    )
    select c.id, 'company', c.id, 'billed_cents', 'calendar_month_utc', 10000,
           false, 'allow', true, true
    from companies c
    where c.status = 'active'
    union all
    select a.company_id, 'agent', a.id, 'billed_cents', 'calendar_month_utc', 10000,
           false, 'allow', true, true
    from agents a
    join companies c on c.id = a.company_id and c.status = 'active'
    where a.status <> 'terminated'
    union all
    select p.company_id, 'project', p.id, 'billed_cents', 'lifetime', 10000,
           false, 'allow', true, true
    from projects p
    join companies c on c.id = p.company_id and c.status = 'active'
    where p.archived_at is null
    on conflict (company_id, scope_type, scope_id, metric, window_kind) do update
    set amount = greatest(budget_policies.amount, excluded.amount),
        hard_stop_enabled = false,
        unpriced_usage_policy = 'allow',
        is_active = true,
        updated_at = now()
    where budget_policies.amount < excluded.amount
       or budget_policies.hard_stop_enabled
       or budget_policies.unpriced_usage_policy is distinct from excluded.unpriced_usage_policy
       or not budget_policies.is_active
    returning id
  `);
  await db.execute(sql`
    update companies
    set budget_monthly_cents = greatest(coalesce(budget_monthly_cents, 0), 10000),
        updated_at = now()
    where status = 'active'
      and coalesce(budget_monthly_cents, 0) < 10000
  `);
  await db.execute(sql`
    update agents a
    set budget_monthly_cents = greatest(coalesce(a.budget_monthly_cents, 0), 10000),
        updated_at = now()
    from companies c
    where c.id = a.company_id and c.status = 'active'
      and a.status <> 'terminated'
      and coalesce(a.budget_monthly_cents, 0) < 10000
  `);

  const targetRes = await db.execute(sql`
    select r.id, r.company_id, r.title,
      case
        when r.id::text in (
          ${OBSOLETE_ROUTINE_IDS[0]}, ${OBSOLETE_ROUTINE_IDS[1]},
          ${OBSOLETE_ROUTINE_IDS[2]}, ${OBSOLETE_ROUTINE_IDS[3]},
          ${OBSOLETE_ROUTINE_IDS[4]}
        ) then 'obsolete_model_automation'
        when r.id::text in (
          ${RETIRED_DAILY_ROUTINE_IDS[0]}, ${RETIRED_DAILY_ROUTINE_IDS[1]},
          ${RETIRED_DAILY_ROUTINE_IDS[2]}, ${RETIRED_DAILY_ROUTINE_IDS[3]},
          ${RETIRED_DAILY_ROUTINE_IDS[4]}, ${RETIRED_DAILY_ROUTINE_IDS[5]},
          ${RETIRED_DAILY_ROUTINE_IDS[6]}, ${RETIRED_DAILY_ROUTINE_IDS[7]},
          ${RETIRED_DAILY_ROUTINE_IDS[8]}
        ) then 'retired_daily_planning'
        else 'terminated_assignee'
      end as reason
    from routines r
    join companies c on c.id = r.company_id and c.status = 'active'
    left join agents a on a.id = r.assignee_agent_id and a.company_id = r.company_id
    where (r.status = 'active' or r.id::text in (
        ${OBSOLETE_ROUTINE_IDS[0]}, ${OBSOLETE_ROUTINE_IDS[1]},
        ${OBSOLETE_ROUTINE_IDS[2]}, ${OBSOLETE_ROUTINE_IDS[3]},
        ${OBSOLETE_ROUTINE_IDS[4]}
      ))
      and (
        r.id::text in (
          ${OBSOLETE_ROUTINE_IDS[0]}, ${OBSOLETE_ROUTINE_IDS[1]},
          ${OBSOLETE_ROUTINE_IDS[2]}, ${OBSOLETE_ROUTINE_IDS[3]},
          ${OBSOLETE_ROUTINE_IDS[4]},
          ${RETIRED_DAILY_ROUTINE_IDS[0]}, ${RETIRED_DAILY_ROUTINE_IDS[1]},
          ${RETIRED_DAILY_ROUTINE_IDS[2]}, ${RETIRED_DAILY_ROUTINE_IDS[3]},
          ${RETIRED_DAILY_ROUTINE_IDS[4]}, ${RETIRED_DAILY_ROUTINE_IDS[5]},
          ${RETIRED_DAILY_ROUTINE_IDS[6]}, ${RETIRED_DAILY_ROUTINE_IDS[7]},
          ${RETIRED_DAILY_ROUTINE_IDS[8]}
        )
        or a.status = 'terminated' or a.lifecycle_state = 'terminated'
      )
    order by r.company_id, r.id
  `);
  const targets = targetRes.rows ?? targetRes;
  const routineIds = Array.isArray(targets) ? targets.map(row => row.id).filter(Boolean) : [];
  if (routineIds.length > 0) {
    await db.execute(sql`
      update routine_triggers
      set enabled = false, archived = true, next_run_at = null, updated_at = now()
      where exists (
        select 1
        from routines r
        join companies c on c.id = r.company_id and c.status = 'active'
        left join agents a on a.id = r.assignee_agent_id and a.company_id = r.company_id
        where r.id = routine_triggers.routine_id
          and (
            r.id::text in (
              ${OBSOLETE_ROUTINE_IDS[0]}, ${OBSOLETE_ROUTINE_IDS[1]},
              ${OBSOLETE_ROUTINE_IDS[2]}, ${OBSOLETE_ROUTINE_IDS[3]},
              ${OBSOLETE_ROUTINE_IDS[4]},
              ${RETIRED_DAILY_ROUTINE_IDS[0]}, ${RETIRED_DAILY_ROUTINE_IDS[1]},
              ${RETIRED_DAILY_ROUTINE_IDS[2]}, ${RETIRED_DAILY_ROUTINE_IDS[3]},
              ${RETIRED_DAILY_ROUTINE_IDS[4]}, ${RETIRED_DAILY_ROUTINE_IDS[5]},
              ${RETIRED_DAILY_ROUTINE_IDS[6]}, ${RETIRED_DAILY_ROUTINE_IDS[7]},
              ${RETIRED_DAILY_ROUTINE_IDS[8]}
            )
            or a.status = 'terminated'
            or a.lifecycle_state = 'terminated'
          )
      )
    `);
    await db.execute(sql`
      update routines
      set status = 'paused', updated_at = now()
      where status = 'active'
        and exists (select 1 from companies c where c.id = routines.company_id and c.status = 'active')
        and (
          id::text in (
            ${RETIRED_DAILY_ROUTINE_IDS[0]}, ${RETIRED_DAILY_ROUTINE_IDS[1]},
            ${RETIRED_DAILY_ROUTINE_IDS[2]}, ${RETIRED_DAILY_ROUTINE_IDS[3]},
            ${RETIRED_DAILY_ROUTINE_IDS[4]}, ${RETIRED_DAILY_ROUTINE_IDS[5]},
            ${RETIRED_DAILY_ROUTINE_IDS[6]}, ${RETIRED_DAILY_ROUTINE_IDS[7]},
            ${RETIRED_DAILY_ROUTINE_IDS[8]}
          )
          or exists (
            select 1 from agents a
            where a.id = routines.assignee_agent_id
              and a.company_id = routines.company_id
              and (a.status = 'terminated' or a.lifecycle_state = 'terminated')
          )
        )
    `);
  }
  const issueRes = await db.execute(sql`
    with target_issues as (
      update issues i
      set status = 'cancelled',
          status_version = i.status_version + 1,
          cancelled_at = now(),
          completed_at = coalesce(i.completed_at, now()),
          execution_run_id = null,
          checkout_run_id = null,
          execution_locked_at = null,
          updated_at = now()
      where i.status not in ('done', 'cancelled')
        and exists (select 1 from companies c where c.id = i.company_id and c.status = 'active')
        and (
          lower(coalesce(i.title, '')) ~ '^review productivity for '
          or (
            i.origin_kind = 'routine_execution'
            and exists (
              select 1
              from routines source_routine
              left join agents source_agent
                on source_agent.id = source_routine.assignee_agent_id
                and source_agent.company_id = source_routine.company_id
              where source_routine.company_id = i.company_id
                and source_routine.id::text = i.origin_id
                and (
                  source_routine.id::text in (
                    ${OBSOLETE_ROUTINE_IDS[0]}, ${OBSOLETE_ROUTINE_IDS[1]},
                    ${OBSOLETE_ROUTINE_IDS[2]}, ${OBSOLETE_ROUTINE_IDS[3]},
                    ${OBSOLETE_ROUTINE_IDS[4]},
                    ${RETIRED_DAILY_ROUTINE_IDS[0]}, ${RETIRED_DAILY_ROUTINE_IDS[1]},
                    ${RETIRED_DAILY_ROUTINE_IDS[2]}, ${RETIRED_DAILY_ROUTINE_IDS[3]},
                    ${RETIRED_DAILY_ROUTINE_IDS[4]}, ${RETIRED_DAILY_ROUTINE_IDS[5]},
                    ${RETIRED_DAILY_ROUTINE_IDS[6]}, ${RETIRED_DAILY_ROUTINE_IDS[7]},
                    ${RETIRED_DAILY_ROUTINE_IDS[8]}
                  )
                  or source_agent.status = 'terminated'
                  or source_agent.lifecycle_state = 'terminated'
                )
            )
          )
        )
      returning i.id, i.company_id, i.title
    ),
    cancel_runs as (
      update heartbeat_runs r
      set status = 'cancelled',
          error = coalesce(r.error, 'Cancelled obsolete model automation task'),
          error_code = coalesce(r.error_code, 'operator_interrupted'),
          finished_at = coalesce(r.finished_at, now()),
          updated_at = now()
      from target_issues i
      where r.company_id = i.company_id
        and r.status in ('queued', 'scheduled_retry')
        and coalesce(r.issue_id::text, r.context_snapshot ->> 'issueId') = i.id::text
      returning r.id
    ),
    cancel_wakeups as (
      update agent_wakeup_requests w
      set status = 'cancelled',
          error = coalesce(w.error, 'Cancelled obsolete model automation task'),
          finished_at = coalesce(w.finished_at, now()),
          updated_at = now()
      where w.status in ('queued', 'claimed', 'deferred_issue_execution')
        and coalesce(w.payload ->> 'issueId', '') in (select id::text from target_issues)
      returning w.id
    ),
    cancel_routine_runs as (
      update routine_runs rr
      set status = 'cancelled',
          failure_reason = coalesce(rr.failure_reason, 'Cancelled obsolete model automation task'),
          completed_at = coalesce(rr.completed_at, now()),
          updated_at = now()
      where rr.status not in ('completed', 'succeeded', 'failed', 'cancelled', 'skipped', 'coalesced')
        and (
          exists (
            select 1
            from routines source_routine
            left join agents source_agent
              on source_agent.id = source_routine.assignee_agent_id
              and source_agent.company_id = source_routine.company_id
            where source_routine.id = rr.routine_id
              and source_routine.company_id = rr.company_id
              and (
                source_routine.id::text in (
                  ${OBSOLETE_ROUTINE_IDS[0]}, ${OBSOLETE_ROUTINE_IDS[1]},
                  ${OBSOLETE_ROUTINE_IDS[2]}, ${OBSOLETE_ROUTINE_IDS[3]},
                  ${OBSOLETE_ROUTINE_IDS[4]},
                  ${RETIRED_DAILY_ROUTINE_IDS[0]}, ${RETIRED_DAILY_ROUTINE_IDS[1]},
                  ${RETIRED_DAILY_ROUTINE_IDS[2]}, ${RETIRED_DAILY_ROUTINE_IDS[3]},
                  ${RETIRED_DAILY_ROUTINE_IDS[4]}, ${RETIRED_DAILY_ROUTINE_IDS[5]},
                  ${RETIRED_DAILY_ROUTINE_IDS[6]}, ${RETIRED_DAILY_ROUTINE_IDS[7]},
                  ${RETIRED_DAILY_ROUTINE_IDS[8]}
                )
                or source_agent.status = 'terminated'
                or source_agent.lifecycle_state = 'terminated'
              )
          )
          or rr.linked_issue_id in (select id from target_issues)
        )
      returning rr.id
    )
    select id, company_id, title from target_issues
  `);
  const issues = issueRes.rows ?? issueRes;
  const staleQueueRes = await db.execute(sql`
    with queued as (
      select
        r.id,
        r.company_id,
        r.agent_id,
        r.wakeup_request_id,
        row_number() over (
          partition by r.company_id, r.agent_id,
            coalesce(r.issue_id::text, nullif(r.context_snapshot ->> 'issueId', ''),
              r.context_snapshot ->> 'taskKey', r.id::text)
          order by r.created_at desc, r.id desc
        ) as duplicate_rank,
        i.status as issue_status
      from heartbeat_runs r
      join agents a on a.id = r.agent_id and a.company_id = r.company_id
      join companies c on c.id = r.company_id and c.status = 'active'
      left join issues i on i.company_id = r.company_id
        and i.id::text = nullif(coalesce(r.issue_id::text, r.context_snapshot ->> 'issueId'), '')
      where r.status = 'queued'
        and a.adapter_type = 'openrouter'
    ),
    cancelled_runs as (
      update heartbeat_runs r
      set status = 'cancelled',
          error = coalesce(r.error, 'Cancelled stale, duplicate, or no-longer-actionable queued wakeup'),
          error_code = coalesce(r.error_code, 'operator_interrupted'),
          finished_at = coalesce(r.finished_at, now()),
          updated_at = now()
      from queued q
      where r.id = q.id
        and (
          q.issue_status in ('done', 'cancelled', 'blocked')
          or q.duplicate_rank > 1
          or (
            r.created_at < now() - interval '48 hours'
            and exists (
              select 1 from heartbeat_runs newer
              where newer.company_id = r.company_id
                and newer.agent_id = r.agent_id
                and coalesce(newer.issue_id::text, newer.context_snapshot ->> 'issueId') =
                    coalesce(r.issue_id::text, r.context_snapshot ->> 'issueId')
                and (newer.created_at, newer.id) > (r.created_at, r.id)
            )
          )
        )
      returning r.id, r.wakeup_request_id
    ),
    cancelled_wakeups as (
      update agent_wakeup_requests w
      set status = 'cancelled',
          error = coalesce(w.error, 'Cancelled stale, duplicate, or no-longer-actionable queued wakeup'),
          finished_at = coalesce(w.finished_at, now()),
          updated_at = now()
      from cancelled_runs r
      where (w.id = r.wakeup_request_id or w.run_id = r.id)
        and w.status in ('queued', 'claimed', 'deferred_issue_execution')
      returning w.id
    )
    select id from cancelled_runs
  `);
  const cancelledStaleRuns = staleQueueRes.rows ?? staleQueueRes;

  await db.execute(sql`
    update routine_triggers t
    set cron_expression = case t.routine_id::text
          when 'bb3dab66-a107-4f1f-9f7b-7b305f25e3e2' then '0 4 * * 1,3,5'
          when '3bd6a48e-f2ae-4084-9eb0-15cf864e35e6' then '0 7 1,15 * *'
          when 'a676e35a-a726-4667-8c06-4bb874c8f5e2' then '0 8 * * 1'
          else t.cron_expression
        end,
        enabled = case
          when t.routine_id::text = 'a676e35a-a726-4667-8c06-4bb874c8f5e2' then true
          else t.enabled
        end,
        next_run_at = case
          when t.routine_id::text = 'a676e35a-a726-4667-8c06-4bb874c8f5e2' then now() + interval '1 day'
          else t.next_run_at
        end,
        updated_at = now()
    where t.kind = 'schedule'
      and t.routine_id::text in (
        'bb3dab66-a107-4f1f-9f7b-7b305f25e3e2',
        '3bd6a48e-f2ae-4084-9eb0-15cf864e35e6',
        'a676e35a-a726-4667-8c06-4bb874c8f5e2'
      )
  `);
  const throttledRes = await db.execute(sql`
    update routine_triggers t
    set next_run_at = now() + interval '6 hours',
        last_result = 'deferred_openrouter_backlog',
        updated_at = now()
    from routines r
    where t.routine_id = r.id
      and t.kind = 'schedule'
      and t.enabled
      and not t.archived
      and r.status = 'active'
      and t.next_run_at <= now() + interval '15 minutes'
      and exists (
        select 1
        from heartbeat_runs queued
        where queued.company_id = r.company_id
          and queued.agent_id = r.assignee_agent_id
          and queued.status = 'queued'
        group by queued.company_id, queued.agent_id
        having count(*) > 2 or min(queued.created_at) < now() - interval '24 hours'
      )
    returning t.id, r.id as routine_id
  `);
  const deletedRes = await db.execute(sql`
    delete from routines
    where id::text in (
      ${OBSOLETE_ROUTINE_IDS[0]}, ${OBSOLETE_ROUTINE_IDS[1]},
      ${OBSOLETE_ROUTINE_IDS[2]}, ${OBSOLETE_ROUTINE_IDS[3]},
      ${OBSOLETE_ROUTINE_IDS[4]}
    )
    returning id, company_id, title
  `);
  const deletedRoutines = deletedRes.rows ?? deletedRes;
  if (Array.isArray(targets)) {
    for (const routine of targets) {
      logger?.info?.({
        tag: "openrouter.reconcile.cleanup",
        kind: "routine",
        companyId: routine.company_id,
        routineId: routine.id,
        title: routine.title,
        reason: routine.reason,
      }, routine.reason === "obsolete_model_automation"
        ? "Deleted obsolete model automation routine"
        : "Paused retired or unassignable routine");
    }
  }
  if (Array.isArray(issues)) {
    for (const issue of issues) {
      logger?.info?.({
        tag: "openrouter.reconcile.cleanup",
        kind: "issue",
        companyId: issue.company_id,
        issueId: issue.id,
        title: issue.title,
        reason: "obsolete_model_automation",
      }, "Cancelled obsolete model automation task");
    }
  }
  const policyRows = policyRes.rows ?? policyRes;
  const throttledRows = throttledRes.rows ?? throttledRes;
  return {
    detachedRunsRecovered: Array.isArray(detachedRuns) ? detachedRuns.length : 0,
    policiesHealed: Array.isArray(policyRows) ? policyRows.length : 0,
    routinesPaused: routineIds.filter(id => !OBSOLETE_ROUTINE_IDS.includes(id)).length,
    issuesCancelled: (Array.isArray(issues) ? issues.length : 0),
    staleRunsCancelled: Array.isArray(cancelledStaleRuns) ? cancelledStaleRuns.length : 0,
    routinesDeleted: Array.isArray(deletedRoutines) ? deletedRoutines.length : 0,
    routinesDeferred: Array.isArray(throttledRows) ? throttledRows.length : 0,
  };
}

export async function reconcileOpenRouterControlPlaneSafely(db, sql, logger) {
  try {
    return await reconcileOpenRouterControlPlane(db, sql, logger);
  } catch (error) {
    logger?.error?.({
      err: error,
      tag: "openrouter.reconcile.control_plane_error",
    }, "OpenRouter control-plane cleanup failed; execution recovery continues");
    return {
      detachedRunsRecovered: 0,
      policiesHealed: 0,
      routinesPaused: 0,
      issuesCancelled: 0,
      staleRunsCancelled: 0,
      routinesDeleted: 0,
      routinesDeferred: 0,
    };
  }
}

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
  if (typeof deps?.resumeAgentLifecycle === "function") {
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
          await deps.resumeAgentLifecycle(db, row.id);
          resumedAgents += 1;
        } catch (error) {
          logger?.error?.({ err: error, agentId: row.id }, "OpenRouter paused agent lifecycle resume failed");
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
  const controlPlane = await reconcileOpenRouterControlPlaneSafely(db, sql, logger);
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
      if (readyAgents > 0 && queuedRuns > 0 && runningRuns < resolveOpenRouterMaxConcurrentRuns() && !freePoolExhaustedUntil() && typeof deps.notifyQueuedRunDispatch === "function") {
        if (typeof db.transaction === "function") {
          await db.transaction(async (tx) => {
            await deps.notifyQueuedRunDispatch(tx);
          });
        } else {
          await deps.notifyQueuedRunDispatch(db);
        }
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
          freePoolExhaustedUntil: freePoolExhaustedUntil() ? new Date(freePoolExhaustedUntil()).toISOString() : null,
          freePoolLanes: globalThis[Symbol.for("paperclip.freePool")]?.status?.().lanes
            ?.map(lane => `${lane.id}:${lane.enabled ? (lane.cooldownUntil ? "cooling" : "ready") : "disabled"}:${lane.ok}/${lane.failed}`) ?? null,
          unparkedAgents: readiness.unparkedAgents,
          healedAgents: readiness.healedAgents,
          resumedAgents: readiness.resumedAgents,
          scheduledRetries: scheduled,
          ...controlPlane,
        }, "OpenRouter readiness and retry state");
      }
      const companyRes = await db.execute(sql`
        select c.id as company_id, c.name,
          count(distinct a.id) filter (
            where a.adapter_type = 'openrouter' and a.lifecycle_state = 'ready'
              and a.status not in ('paused', 'terminated', 'pending_approval')
          )::int as ready_agents,
          count(distinct r.id) filter (where r.status = 'queued')::int as queued_runs,
          count(distinct r.id) filter (where r.status = 'running')::int as running_runs,
          count(distinct r.id) filter (where r.status = 'scheduled_retry')::int as scheduled_retry_runs
        from companies c
        left join agents a on a.company_id = c.id
        left join heartbeat_runs r on r.company_id = c.id and r.agent_id = a.id
          and a.adapter_type = 'openrouter'
        where c.status = 'active'
        group by c.id, c.name
        order by c.id
      `);
      for (const company of (companyRes.rows ?? companyRes ?? [])) {
        logger?.info?.({
          tag: "openrouter.reconcile.company",
          companyId: company.company_id,
          companyName: company.name,
          readyAgents: Number(company.ready_agents ?? 0),
          queuedRuns: Number(company.queued_runs ?? 0),
          runningRuns: Number(company.running_runs ?? 0),
          scheduledRetryRuns: Number(company.scheduled_retry_runs ?? 0),
        }, "OpenRouter company queue state");
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
  for (const [name, anchor, replacement] of [
    ["runnerSelection",
      "export async function resolveNewAgentRunnerForCompany(db, companyId, input) {",
      `export async function resolveNewAgentRunnerForCompany(db, companyId, input) {
    const { adapterType, adapterConfig } = normalizeFreeAgentConfiguration(input);
    return { adapterType, adapterConfig };
}
async function upstreamResolveNewAgentRunnerForCompany(db, companyId, input) {`],
    ["agentHiring",
      "export async function prepareAgentHire(db, companyId, input, options) {",
      "export async function prepareAgentHire(db, companyId, input, options) {\n    input = normalizeFreeAgentConfiguration(input);"],
    ["agentConfiguration",
      "export async function prepareAgentConfiguration(db, existing, data, options) {",
      "export async function prepareAgentConfiguration(db, existing, data, options) {\n    data = normalizeFreeAgentConfiguration(data, existing);"],
  ]) {
    if (output[name] === undefined) continue;
    output[name] = replaceOnce(output[name], anchor, replacement);
    if (!output[name].includes(imported("normalizeFreeAgentConfiguration"))) {
      output[name] = imported("normalizeFreeAgentConfiguration") + output[name];
    }
  }
  if (output.agentsRoutes !== undefined) {
    output.agentsRoutes = replaceOnce(output.agentsRoutes,
      "        const normalized = normalizeNewAgentRuntimeConfig(runtimeConfig);",
      `        const normalized = normalizeNewAgentRuntimeConfig(runtimeConfig);
        if (adapterType === "openrouter") {
            delete normalized.aiConnection;
            return normalized;
        }`);
  }
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
    'import { isAgentAwaitingSetup } from "../../modules/agent-lifecycle/index.js";\nimport { createAgentLifecycle, scheduleAgentLifecycle } from "../agent-lifecycle.js";\nimport { runUsedConversationAdapter } from "../conversation-continuation.js";');
  output.recovery = replaceOnce(output.recovery,
    '    async function reconcileStrandedAssignedIssues(opts) {',
    '    async function reconcileStrandedAssignedIssues(opts) {\n        scheduleOpenRouterRetrySweep(db, { ...deps, resumeAgentLifecycle: (targetDb, agentId) => createAgentLifecycle(targetDb).resumeAgent(agentId, "user"), scheduleAgentLifecycle, notifyQueuedRunDispatch }, sql, logger);');
  if (!output.recovery.includes(imported("scheduleOpenRouterRetrySweep"))) {
    output.recovery = imported("scheduleOpenRouterRetrySweep") + output.recovery;
  }
  if (typeof output.routines === "string") {
    output.routines = replaceOnce(output.routines,
      "        tickScheduledTriggers: async (now = new Date(), canContinue = () => true) => {",
      `        tickScheduledTriggers: async (now = new Date(), canContinue = () => true) => {
            await reconcileOpenRouterControlPlaneSafely(db, sql, logger);`);
    if (!output.routines.includes(imported("reconcileOpenRouterControlPlaneSafely"))) {
      output.routines = imported("reconcileOpenRouterControlPlaneSafely") + output.routines;
    }
  }
  if (typeof output.agentsRoutes === "string") {
    output.agentsRoutes = replaceOnce(output.agentsRoutes,
      '    router.get("/companies/:companyId/provider-traces", async (req, res) => {',
      `    router.get("/companies/:companyId/openrouter-queue", async (req, res) => {
        const companyId = req.params.companyId;
        assertCompanyAccess(req, companyId);
        if (!(await assertRunTelemetryReadAllowed(req, res, companyId)))
            return;
        res.set("Cache-Control", "no-cache, no-store");
        res.json(await listOpenRouterQueue(db, companyId, sql));
    });
    router.get("/companies/:companyId/provider-traces", async (req, res) => {`);
    const agentsRoutesImports = imported("listOpenRouterQueue");
    if (!output.agentsRoutes.includes(agentsRoutesImports)) {
      output.agentsRoutes = agentsRoutesImports + output.agentsRoutes;
    }
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
    '        if (!executionTargetIsRemote) {\n            await ensurePiModelConfiguredAndAvailable({',
    '        if (!executionTargetIsRemote && runtimeEnv.PAPERCLIP_OPENROUTER_FREE_ONLY !== "1") {\n            await ensurePiModelConfiguredAndAvailable({');
  output.piExecute = replaceOnce(output.piExecute,
    '        await Promise.all([preparedRuntimeConfig.cleanup(), attributionExtension?.cleanup()]);',
    '        await Promise.all([preparedRuntimeConfig.cleanup(), attributionExtension?.cleanup(), localSystemPromptDir ? fs.rm(localSystemPromptDir, { recursive: true, force: true }).catch(() => undefined) : Promise.resolve()]);');
  if (typeof output.piModels === "string") {
    output.piModels = replaceOnce(output.piModels,
      '    const result = await runChildProcess(`pi-models-${Date.now()}-${Math.random().toString(16).slice(2)}`, command, ["--list-models"], {',
      '    const listArgs = typeof input.searchPattern === "string" && input.searchPattern.trim().length > 0 ? ["--list-models", input.searchPattern.trim()] : ["--list-models"];\n    const result = await runChildProcess(`pi-models-${Date.now()}-${Math.random().toString(16).slice(2)}`, command, listArgs, {');
    output.piModels = replaceOnce(output.piModels,
      '    // Pi outputs model list to stderr, but fall back to stdout for older versions\n    const output = result.stderr || result.stdout;\n    return sortModels(dedupeModels(parseModelsOutput(output)));',
      '    const stdoutModels = parseModelsOutput(result.stdout);\n    const parsedModels = stdoutModels.length > 0 ? stdoutModels : parseModelsOutput(result.stderr);\n    return sortModels(dedupeModels(parsedModels));');
    output.piModels = replaceOnce(output.piModels,
      '    if (!models.some((entry) => entry.id === model)) {\n        throw new Error(`Configured Pi model is unavailable: ${model}. ${models.length} models are available; list them with \\`pi --list-models\\`.`);\n    }',
      `    if (!models.some((entry) => entry.id === model)) {
        const slashIndex = model.indexOf("/");
        const targeted = await discoverPiModels({
            command: input.command,
            cwd: input.cwd,
            env: input.env,
            searchPattern: slashIndex > 0 ? \`\${model.slice(0, slashIndex)} \${model.slice(slashIndex + 1)}\` : model,
        });
        if (!targeted.some((entry) => entry.id === model)) {
            throw new Error(\`Configured Pi model is unavailable: \${model}. \${models.length} models are available; list them with \\\`pi --list-models\\\`.\`);
        }
        const merged = sortModels(dedupeModels([...models, ...targeted]));
        const cacheKey = discoveryCacheKey(resolvePiCommand(input.command), asString(input.cwd, process.cwd()), normalizeEnv(input.env));
        discoveryCache.set(cacheKey, { expiresAt: Date.now() + MODELS_CACHE_TTL_MS, models: merged });
        return merged;
    }`);
  }
  if (typeof output.piMain === "string") {
    output.piMain = replaceOnce(output.piMain,
      `    if (parsed.listModels !== undefined) {
        const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;
        await listModels(modelRegistry, searchPattern);
        process.exit(0);
    }`,
      `    if (parsed.listModels !== undefined) {
        const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;
        await listModels(modelRegistry, searchPattern);
        restoreStdout();
        const flushStream = (stream) => stream.destroyed || stream.writableEnded
            ? Promise.resolve()
            : new Promise((resolve) => {
                const done = () => resolve();
                stream.once("error", done);
                stream.write("", done);
            });
        await flushStream(process.stdout);
        await flushStream(process.stderr);
        process.exit(0);
    }`);
  }
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
            .selectDistinct({ agentId: heartbeatRuns.agentId, companyId: heartbeatRuns.companyId })
            .from(heartbeatRuns)
            .innerJoin(companies, eq(companies.id, heartbeatRuns.companyId))
            .where(and(eq(heartbeatRuns.status, "queued"), scope ? eq(heartbeatRuns.companyId, scope.companyId) : undefined, eq(companies.status, "active"), cutoff ? gte(heartbeatRuns.createdAt, cutoff) : undefined, openRouterQueuedRunClaimableSql(heartbeatRuns, sql)));
        const agentIds = orderQueuedAgents(queuedRuns);`);
  output.queue = replaceOnce(output.queue,
    `                or coalesce(prior.continuation_attempt, 0) > 0)))
          )\`));
        for (const { agentId } of rows) {
            await startNextQueuedRunForAgent(agentId);
        }`,
    `                or coalesce(prior.continuation_attempt, 0) > 0)))
          )\`, openRouterQueuedRunClaimableSql(heartbeatRuns, sql)));
        for (const agentId of orderQueuedAgents(rows.map((r) => ({ agentId: r.agentId, companyId: r.companyId })))) {
            await startNextQueuedRunForAgent(agentId);
        }`);
  output.queue = replaceOnce(output.queue,
    `const rows = await db
            .selectDistinct({ agentId: heartbeatRuns.agentId })`,
    `const rows = await db
            .selectDistinct({ agentId: heartbeatRuns.agentId, companyId: heartbeatRuns.companyId })`);
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
  const queueImports = imported("hasOpenRouterHourlyWait, limitOpenRouterAvailableSlots, openRouterQueuedRunClaimableSql, orderQueuedAgents, selectClaimableQueuedRuns, triggerOpenRouterQueueDrain, withOpenRouterClaimLock");
  if (!output.queue.includes(queueImports)) {
    output.queue = queueImports + output.queue;
  }
  output.lifecycle = replaceOnce(output.lifecycle,
    'const retry = options?.retryRequired && agent.lifecycleState === "verifying"',
    'const retry = options?.retryRequired && agent.lifecycleState === "verifying" && agent.adapterType !== "openrouter"');
  output.lifecycle = replaceOnce(output.lifecycle,
    'new Date(now.getTime() + (error ? 60_000 : 2_000)).toISOString()',
    'new Date(now.getTime() + (error ? (agent.adapterType === "openrouter" && agent.lifecycleState === "verifying" ? 3_600_000 : 60_000) : 2_000)).toISOString()');
  if (typeof output.runControl === "string") {
    output.runControl = replaceOnce(output.runControl,
      '    async function completedRunTerminationProof(run) {\n',
      `    async function completedRunTerminationProof(run) {
        const upstreamProof = await upstreamCompletedRunTerminationProof(run);
        if (upstreamProof !== null || !isHeartbeatRunTerminalStatus(run.status))
            return upstreamProof;
        const inMemory = activeRunExecutions.has(run.id) || runningProcesses.has(run.id) ||
            adapterExecutionControls.has(run.id) || processRunCancellationSettlements.has(run.id);
        if (inMemory)
            return null;
        const leases = await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id)));
        const owner = await Promise.resolve(getAgent(run.agentId)).catch(() => null);
        return openRouterLocalTerminationProof({ terminal: true, inMemory, agent: owner, leases });
    }
    async function upstreamCompletedRunTerminationProof(run) {
`);
    const runControlImports = imported("openRouterLocalTerminationProof");
    if (!output.runControl.includes(runControlImports)) {
      output.runControl = runControlImports + output.runControl;
    }
  }
  return output;
}

// Paperclip only accepts a committed budget Stop after it sees proof that the provider
// process exited. The openrouter adapter runs Pi as an in-process local child that the
// server awaits until exit, so a terminal run that no live execution map owns has no
// surviving provider. Without this, such Stops stay pending forever.
export function openRouterLocalTerminationProof({ terminal, inMemory, agent, leases }) {
  if (!terminal || inMemory || agent?.adapterType !== "openrouter") return null;
  return (leases ?? []).every(lease => lease?.provider === "local") ? "openrouter_local_terminal" : null;
}

export function enforceOpenRouterRecovery(root = fileURLToPath(new URL("..", import.meta.url))) {
  const base = join(root, "node_modules", "@paperclipai");
  const files = {
    retries: join(base, "server", "dist", "services", "heartbeat", "retries.js"),
    completion: join(base, "server", "dist", "services", "heartbeat", "run-completion.js"),
    recovery: join(base, "server", "dist", "services", "recovery", "service.js"),
    pi: join(base, "adapter-pi-local", "dist", "server", "runtime-config.js"),
    piExecute: join(base, "adapter-pi-local", "dist", "server", "execute.js"),
    piModels: join(base, "adapter-pi-local", "dist", "server", "models.js"),
    piMain: join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "main.js"),
    conversation: join(base, "server", "dist", "services", "conversation-continuation.js"),
    queue: join(base, "server", "dist", "services", "heartbeat", "queue.js"),
    lifecycle: join(base, "server", "dist", "modules", "agent-lifecycle", "adapters", "postgres.js"),
    runControl: join(base, "server", "dist", "services", "heartbeat", "run-control.js"),
    routines: join(base, "server", "dist", "services", "routines.js"),
    agentsRoutes: join(base, "server", "dist", "routes", "agents.js"),
    runnerSelection: join(base, "server", "dist", "services", "agent-runner-selection.js"),
    agentHiring: join(base, "server", "dist", "services", "agent-hiring.js"),
    agentConfiguration: join(base, "server", "dist", "services", "agent-configuration.js"),
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
