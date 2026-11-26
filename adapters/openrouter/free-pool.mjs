import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { routeRequest } from "./policy.mjs";

// In-process OpenAI-compatible gateway that spreads agent traffic across free
// provider lanes (Gemini free tier models, then OpenRouter's free router) and
// fails over on quota/overload errors. Only $0 inference is ever attempted:
// Gemini lanes stay disabled unless the key is verified to be on the free tier.

const POOL_SYMBOL = Symbol.for("paperclip.freePool");
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
export const GEMINI_DUMMY_SIGNATURE = "skip_thought_signature_validator";
export const DEFAULT_GEMINI_FREE_MODELS = [
  "gemini-2.5-flash",
  "gemini-3-flash-preview",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.6-flash",
  "gemini-2.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3.7-flash",
  "gemini-3.8-flash",
];
// Paid-only models: a free-tier project gets 429 with *-FreeTier quota ids.
const DEFAULT_TIER_PROBE_MODELS = ["gemini-4-argon", "gemini-3.1-pro-preview", "gemini-4-carbon"];
const MAX_COOLDOWN_MS = 60 * 60 * 1000;
const TRANSIENT_COOLDOWN_MS = 60_000;
const TIER_RECHECK_MS = 6 * 60 * 60 * 1000;
const TIER_RETRY_MS = 10 * 60 * 1000;
const SIGNATURE_CACHE_LIMIT = 20_000;
const FORWARDED_OPENROUTER_HEADERS = ["http-referer", "x-title", "x-openrouter-title", "x-openrouter-categories"];
const MAX_COMPLETION_BYTES = 8 * 1024 * 1024;

class CompletionError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readVerifiedCompletion(response, onChunk = () => {}) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    onChunk();
    bytes += chunk.byteLength;
    if (bytes > MAX_COMPLETION_BYTES) throw new CompletionError(502, "Provider completion exceeded the 8 MiB limit");
    chunks.push(Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks);
  const text = buffer.toString("utf8");
  const streaming = response.headers.get("content-type")?.includes("text/event-stream");
  const payloads = streaming
    ? text.split(/\r?\n\r?\n/).map(event => event.split(/\r?\n/)
      .filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n"))
      .filter(data => data && data !== "[DONE]")
    : [text];
  let finished = false;
  for (const payload of payloads) {
    let data;
    try { data = JSON.parse(payload); } catch { throw new CompletionError(502, "Invalid JSON in provider completion"); }
    if (data.error) {
      const code = Number(data.error.code);
      throw new CompletionError(code >= 400 && code <= 599 ? code : 502, JSON.stringify({ error: data.error }));
    }
    for (const choice of data.choices ?? []) {
      const reason = choice.finish_reason;
      if (reason == null) continue;
      if (/MALFORMED_FUNCTION_CALL|function_call_filter/i.test(String(reason))) {
        throw new CompletionError(400, `Provider finish_reason: ${reason}`);
      }
      if (!["stop", "length", "tool_calls", "function_call", "content_filter"].includes(reason)) {
        throw new CompletionError(502, `Unsupported provider finish_reason: ${reason}`);
      }
      finished = true;
    }
  }
  if (!finished) throw new CompletionError(502, "Stream ended without finish_reason");
  return buffer;
}

function parseList(value, fallback) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.split(",").map(item => item.trim()).filter(Boolean);
}

function positiveMs(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nextUtcMidnight(now) {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

function nextPacificMidnight(now) {
  // Gemini daily quotas reset at midnight America/Los_Angeles.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(now));
  const get = type => Number(parts.find(part => part.type === type)?.value ?? 0);
  const elapsed = ((get("hour") % 24) * 3600 + get("minute") * 60 + get("second")) * 1000;
  return now - elapsed + 24 * 3600 * 1000;
}

function parseDurationMs(value) {
  const match = typeof value === "string" ? /^(\d+(?:\.\d+)?)s$/.exec(value.trim()) : null;
  return match ? Math.ceil(Number(match[1]) * 1000) : null;
}

function firstError(body) {
  const parsed = Array.isArray(body) ? body[0] : body;
  return parsed?.error && typeof parsed.error === "object" ? parsed.error : null;
}

function errorMessage(body, text) {
  const message = firstError(body)?.message;
  return (typeof message === "string" && message ? message : text || "").replace(/\s+/g, " ").slice(0, 300);
}

export function classifyFailure(lane, status, text, headers, now = Date.now()) {
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON upstream error */ }
  const message = errorMessage(body, text);
  const details = Array.isArray(firstError(body)?.details) ? firstError(body).details : [];
  if (status === 429 || status === 402) {
    let until = now + TRANSIENT_COOLDOWN_MS;
    let daily = false;
    if (lane.provider === "gemini") {
      const quotaIds = details.flatMap(detail => (detail.violations ?? []).map(v => String(v.quotaId ?? "")));
      daily = quotaIds.some(id => /PerDay/i.test(id));
      const retryDelay = details.map(detail => parseDurationMs(detail.retryDelay)).find(Boolean);
      until = daily ? nextPacificMidnight(now) : now + (retryDelay ?? TRANSIENT_COOLDOWN_MS);
      if (!/FreeTier/.test(text)) {
        return { failover: true, cooldownUntil: now + MAX_COOLDOWN_MS, reason: "gemini_not_free_tier", message, disableGemini: true };
      }
    } else {
      daily = status === 402 || /per-day|per day|credits/i.test(message);
      const retryAfter = Number(headers?.get?.("retry-after"));
      until = daily ? nextUtcMidnight(now) : now + (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : TRANSIENT_COOLDOWN_MS);
    }
    return { failover: true, cooldownUntil: Math.min(until, now + MAX_COOLDOWN_MS), reason: daily ? "quota_daily" : "quota_rate", message };
  }
  if (status === 401 || status === 403 || (status === 400 && /API[_ ]KEY/i.test(text))) {
    return { failover: true, cooldownUntil: now + MAX_COOLDOWN_MS, reason: "auth", message };
  }
  if (status === 404) {
    return { failover: true, cooldownUntil: now + MAX_COOLDOWN_MS, reason: "model_unavailable", message };
  }
  if (status === 400 && /MALFORMED_FUNCTION_CALL|function_call_filter/i.test(text)) {
    return { failover: true, cooldownUntil: now + TRANSIENT_COOLDOWN_MS, reason: "malformed_tool_call", message };
  }
  if (status === 408 || status >= 500) {
    return { failover: true, cooldownUntil: now + TRANSIENT_COOLDOWN_MS, reason: "overloaded", message };
  }
  return { failover: false, reason: "rejected", message };
}

function textOfContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => (typeof part === "string" ? part : part?.type === "text" ? part.text ?? "" : "")).join("");
}

function sanitizeParts(content) {
  if (!Array.isArray(content)) return content ?? "";
  const parts = content.flatMap((part) => {
    if (typeof part === "string") return [{ type: "text", text: part }];
    if (part?.type === "text" && typeof part.text === "string") return [{ type: "text", text: part.text }];
    if (part?.type === "image_url" && part.image_url) return [{ type: "image_url", image_url: part.image_url }];
    return [];
  });
  return parts.length ? parts : "";
}

export function toGeminiRequest(body, model, signatureFor = () => undefined) {
  const messages = body.messages.map((message) => {
    const role = message.role === "developer" ? "system" : message.role;
    const out = { role };
    if (role === "tool") {
      out.content = textOfContent(message.content);
      out.tool_call_id = message.tool_call_id;
    } else {
      out.content = sanitizeParts(message.content);
    }
    if (typeof message.name === "string" && message.name && role !== "tool") out.name = message.name;
    if (role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      out.tool_calls = message.tool_calls.map(call => ({
        id: call.id,
        type: "function",
        function: { name: call.function?.name, arguments: call.function?.arguments ?? "{}" },
        extra_content: { google: { thought_signature:
          call.extra_content?.google?.thought_signature ?? signatureFor(call.id) ?? GEMINI_DUMMY_SIGNATURE } },
      }));
      if (out.content === "") out.content = null;
    }
    return out;
  });
  const out = { model, messages };
  for (const key of ["tools", "tool_choice", "stream", "stream_options", "temperature", "top_p", "stop", "n", "response_format", "seed"]) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  if (Number.isSafeInteger(maxTokens) && maxTokens > 0) out.max_completion_tokens = maxTokens;
  out.reasoning_effort = ["low", "medium", "high"].includes(body.reasoning_effort) ? body.reasoning_effort : "low";
  return out;
}

function createSignatureCache() {
  const cache = new Map();
  return {
    get: id => (typeof id === "string" ? cache.get(id) : undefined),
    set(id, signature) {
      if (typeof id !== "string" || !id || typeof signature !== "string" || !signature) return;
      cache.delete(id);
      cache.set(id, signature);
      while (cache.size > SIGNATURE_CACHE_LIMIT) cache.delete(cache.keys().next().value);
    },
    recordToolCalls(calls) {
      if (!Array.isArray(calls)) return;
      for (const call of calls) this.set(call?.id, call?.extra_content?.google?.thought_signature);
    },
    get size() { return cache.size; },
  };
}

export function createFreePool({
  env = process.env,
  fetchImpl = fetch,
  log = entry => console.log(JSON.stringify(entry)),
  now = () => Date.now(),
  sleep = (ms, signal) => new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); }
    signal?.addEventListener("abort", done, { once: true });
  }),
} = {}) {
  const geminiKey = (env.GEMINI_API_KEY || env.GOOGLE_API_KEY || "").trim();
  const geminiEnabled = Boolean(geminiKey) && env.FREE_POOL_GEMINI !== "0";
  const geminiModels = parseList(env.FREE_POOL_GEMINI_MODELS, DEFAULT_GEMINI_FREE_MODELS);
  const tierProbeModels = parseList(env.FREE_POOL_GEMINI_TIER_PROBE_MODELS, DEFAULT_TIER_PROBE_MODELS);
  const headerTimeoutMs = positiveMs(env.FREE_POOL_HEADER_TIMEOUT_MS, 90_000);
  const maxWaitMs = env.FREE_POOL_MAX_WAIT_MS === "0" ? 0 : positiveMs(env.FREE_POOL_MAX_WAIT_MS, 150_000);
  const lanes = [
    ...(geminiEnabled
      ? geminiModels.map(model => ({ id: `gemini/${model}`, provider: "gemini", model })) : []),
    { id: "openrouter/free", provider: "openrouter", model: "openrouter/free" },
  ].map(lane => ({ ...lane, cooldownUntil: 0, reason: null, ok: 0, failed: 0, busy: false }));
  const tokens = new Map();
  const signatures = createSignatureCache();
  const tier = { state: geminiEnabled ? "unverified" : "absent", checkedAt: 0, inFlight: null };
  let server = null;
  let listening = null;
  let baseUrl = null;
  let laneCursor = 0;

  function emit(entry) {
    try { log({ tag: "freepool", ...entry }); } catch { /* never fail on logging */ }
  }

  async function verifyGeminiTier(force = false) {
    if (!geminiEnabled) return false;
    const age = now() - tier.checkedAt;
    if (!force && tier.state === "free" && age < TIER_RECHECK_MS) return true;
    if (!force && tier.state !== "free" && tier.checkedAt && age < TIER_RETRY_MS) return false;
    if (tier.inFlight) return tier.inFlight;
    tier.inFlight = (async () => {
      let verdict = "unverified";
      for (const model of tierProbeModels) {
        try {
          const response = await fetchImpl(GEMINI_URL, {
            method: "POST",
            headers: { Authorization: `Bearer ${geminiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ model, messages: [{ role: "user", content: "ok" }], max_completion_tokens: 1 }),
            signal: AbortSignal.timeout(30_000),
          });
          const text = await response.text();
          if (response.status === 429 && /FreeTier/.test(text)) { verdict = "free"; break; }
          if (response.ok) { verdict = "billed"; break; }
        } catch { /* try the next probe model */ }
      }
      tier.state = verdict;
      tier.checkedAt = now();
      emit({ event: "gemini_tier", state: verdict });
      return verdict === "free";
    })().finally(() => { tier.inFlight = null; });
    return tier.inFlight;
  }

  function laneEnabled(lane) {
    return lane.provider !== "gemini" || (tier.state === "free" && now() - tier.checkedAt < TIER_RECHECK_MS);
  }

  function availableLanes(preferred) {
    const t = now();
    const ready = lanes.filter(lane => laneEnabled(lane) && lane.cooldownUntil <= t && !lane.busy);
    const sticky = ready.find(lane => lane.id === preferred);
    if (sticky) return [sticky, ...ready.filter(lane => lane !== sticky)];
    if (ready.length <= 1) return ready;
    const offset = laneCursor % ready.length;
    laneCursor = (laneCursor + 1) % 1_000_000;
    return [...ready.slice(offset), ...ready.slice(0, offset)];
  }

  function exhaustedUntil() {
    const t = now();
    const enabled = lanes.filter(laneEnabled);
    if (!enabled.length) return 0;
    if (enabled.some(lane => lane.cooldownUntil <= t)) return 0;
    return Math.min(...enabled.map(lane => lane.cooldownUntil));
  }

  function coolDown(lane, verdict) {
    lane.cooldownUntil = Math.max(lane.cooldownUntil, verdict.cooldownUntil);
    lane.reason = verdict.reason;
    lane.failed += 1;
    if (verdict.disableGemini) {
      tier.state = "billed";
      tier.checkedAt = now();
    }
    emit({ event: "lane_cooldown", lane: lane.id, reason: verdict.reason,
      until: new Date(lane.cooldownUntil).toISOString(), message: verdict.message });
  }

  function recordResponseSignatures(text) {
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      const json = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
      if (!json.startsWith("{") || !json.includes("thought_signature")) continue;
      try {
        const chunk = JSON.parse(json);
        for (const choice of chunk.choices ?? []) {
          signatures.recordToolCalls(choice.delta?.tool_calls);
          signatures.recordToolCalls(choice.message?.tool_calls);
        }
      } catch { /* partial or non-JSON line */ }
    }
  }

  function upstreamRequest(lane, body, grant, incomingHeaders) {
    if (lane.provider === "gemini") {
      return {
        url: GEMINI_URL,
        headers: { Authorization: `Bearer ${geminiKey}`, "Content-Type": "application/json" },
        body: toGeminiRequest(body, lane.model, id => signatures.get(id)),
      };
    }
    const headers = { Authorization: `Bearer ${grant.openrouterKey}`, "Content-Type": "application/json" };
    for (const name of FORWARDED_OPENROUTER_HEADERS) {
      if (typeof incomingHeaders[name] === "string") headers[name] = incomingHeaders[name];
    }
    return { url: OPENROUTER_URL, headers, body: routeRequest(body) };
  }

  function sendJson(res, status, payload) {
    if (res.headersSent) return res.end();
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  }

  async function handle(req, res) {
    if (req.method !== "POST" || !/\/chat\/completions$/.test(new URL(req.url, "http://pool").pathname)) {
      return sendJson(res, 404, { error: { code: 404, message: "Not found" } });
    }
    const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const grant = tokens.get(token);
    if (!grant) return sendJson(res, 401, { error: { code: 401, message: "Unknown free-pool token." } });
    let body;
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      body = JSON.parse(raw);
      if (!Array.isArray(body?.messages)) throw new Error("messages missing");
    } catch {
      return sendJson(res, 400, { error: { code: 400, message: "Invalid chat completion request." } });
    }
    const clientAbort = new AbortController();
    res.on("close", () => { if (!res.writableFinished) clientAbort.abort(); });
    if (geminiEnabled) await verifyGeminiTier();
    const attempted = [];
    let lastFailure = null;
    const waitDeadline = now() + maxWaitMs;
    for (;;) {
      for (const lane of availableLanes(grant.lane)) {
        if (clientAbort.signal.aborted) return res.end();
        // Another request may have claimed this lane while an earlier attempt awaited I/O.
        if (lane.busy || !laneEnabled(lane) || lane.cooldownUntil > now()) continue;
        lane.busy = true;
        const started = now();
        const headerTimer = new AbortController();
        let timer = setTimeout(() => headerTimer.abort(), headerTimeoutMs);
        timer.unref?.();
        // Idle timeout: each received chunk re-arms it, so slow but live streams survive.
        const touch = () => {
          clearTimeout(timer);
          timer = setTimeout(() => headerTimer.abort(), headerTimeoutMs);
          timer.unref?.();
        };
        try {
          const upstream = upstreamRequest(lane, body, grant, req.headers);
          const response = await fetchImpl(upstream.url, {
            method: "POST",
            headers: upstream.headers,
            body: JSON.stringify(upstream.body),
            signal: AbortSignal.any([clientAbort.signal, headerTimer.signal]),
          });
          if (!response.ok) {
            const text = await response.text();
            const verdict = classifyFailure(lane, response.status, text, response.headers, now());
            attempted.push(`${lane.id}:${response.status}`);
            lastFailure = { status: response.status, message: verdict.message };
            if (verdict.failover) {
              coolDown(lane, verdict);
              continue;
            }
            lane.failed += 1;
            emit({ event: "request", runId: grant.runId, lane: lane.id, status: response.status, ms: now() - started,
              attempted, message: verdict.message });
            return sendJson(res, response.status, { error: { code: response.status, message: `${lane.id}: ${verdict.message}` } });
          }
          // Buffer one completion, not the whole agent run: never expose partial tool
          // calls before knowing whether replay on another lane is necessary.
          touch();
          const completion = await readVerifiedCompletion(response, touch);
          if (clientAbort.signal.aborted) return res.end();
          lane.ok += 1;
          grant.lane = lane.id;
          if (lane.provider === "gemini") recordResponseSignatures(completion.toString("utf8"));
          res.writeHead(200, {
            "Content-Type": response.headers.get("content-type") ?? "application/json",
            "Cache-Control": "no-cache",
            "X-Free-Pool-Lane": lane.id,
          });
          res.end(completion);
          emit({ event: "request", runId: grant.runId, agentId: grant.agentId, lane: lane.id, status: 200,
            ms: now() - started, attempted });
          return undefined;
        } catch (error) {
          if (clientAbort.signal.aborted) return res.end();
          const status = error instanceof CompletionError ? error.status : 503;
          const text = String(error?.message ?? error);
          const verdict = classifyFailure(lane, status, text, null, now());
          attempted.push(`${lane.id}:${status}`);
          lastFailure = { status, message: verdict.message };
          emit({ event: "completion_error", runId: grant.runId, lane: lane.id, status, message: verdict.message });
          if (!verdict.failover) {
            lane.failed += 1;
            return sendJson(res, status, { error: { code: status, message: `${lane.id}: ${verdict.message}` } });
          }
          coolDown(lane, verdict);
        } finally {
          clearTimeout(timer);
          lane.busy = false;
        }
      }
      // Per-minute limits clear quickly; hold the request instead of failing the run
      // (which would push it to the next hourly retry).
      const busyLane = lanes.some(lane => laneEnabled(lane) && lane.cooldownUntil <= now() && lane.busy);
      const nextFree = exhaustedUntil() || (busyLane ? now() + 250 : 0);
      if (!nextFree || nextFree > waitDeadline || clientAbort.signal.aborted) break;
      emit({ event: "waiting", runId: grant.runId, until: new Date(nextFree).toISOString() });
      await sleep(Math.max(0, nextFree - now()) + 250, clientAbort.signal);
      if (clientAbort.signal.aborted) return res.end();
    }
    const until = exhaustedUntil();
    const retryAt = until ? new Date(until).toISOString() : null;
    emit({ event: "exhausted", runId: grant.runId, attempted, retryAt });
    const detail = lastFailure ? ` Last error: ${lastFailure.message}` : "";
    return sendJson(res, 429, { error: { code: 429,
      message: `free-models-per-day: every free provider lane is cooling down${retryAt ? ` until ${retryAt}` : ""}.${detail}` } });
  }

  async function start() {
    if (listening) return listening;
    server = createServer((req, res) => {
      handle(req, res).catch((error) => {
        emit({ event: "handler_error", message: String(error?.message ?? error).slice(0, 200) });
        sendJson(res, 500, { error: { code: 500, message: "Free-pool gateway failure." } });
      });
    });
    server.keepAliveTimeout = 5_000;
    listening = new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.unref();
        baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
        emit({ event: "started", lanes: lanes.map(lane => lane.id), geminiTier: tier.state });
        resolve(baseUrl);
      });
    });
    if (geminiEnabled) void verifyGeminiTier();
    return listening;
  }

  return {
    start,
    get baseUrl() { return baseUrl; },
    issueToken(grant) {
      const token = `fp-${randomBytes(24).toString("hex")}`;
      tokens.set(token, { ...grant, lane: null });
      return token;
    },
    revokeToken(token) { tokens.delete(token); },
    exhaustedUntil,
    verifyGeminiTier,
    status() {
      return {
        geminiTier: tier.state,
        exhaustedUntil: exhaustedUntil() || null,
        lanes: lanes.map(({ id, cooldownUntil, reason, ok, failed, busy }) => ({
          id, enabled: laneEnabled(lanes.find(lane => lane.id === id)),
          cooldownUntil: cooldownUntil > now() ? new Date(cooldownUntil).toISOString() : null, reason, ok, failed, busy,
        })),
      };
    },
    async close() {
      if (!server) return;
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(() => resolve()));
      server = null;
      listening = null;
    },
  };
}

export function getSharedFreePool(options) {
  if (!globalThis[POOL_SYMBOL]) globalThis[POOL_SYMBOL] = createFreePool(options);
  return globalThis[POOL_SYMBOL];
}

export function sharedFreePoolExhaustedUntil() {
  return globalThis[POOL_SYMBOL]?.exhaustedUntil?.() ?? 0;
}
