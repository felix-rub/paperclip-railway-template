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
} = {}) {
  const geminiKey = (env.GEMINI_API_KEY || env.GOOGLE_API_KEY || "").trim();
  const geminiModels = parseList(env.FREE_POOL_GEMINI_MODELS, DEFAULT_GEMINI_FREE_MODELS);
  const tierProbeModels = parseList(env.FREE_POOL_GEMINI_TIER_PROBE_MODELS, DEFAULT_TIER_PROBE_MODELS);
  const headerTimeoutMs = positiveMs(env.FREE_POOL_HEADER_TIMEOUT_MS, 90_000);
  const lanes = [
    ...(geminiKey && env.FREE_POOL_GEMINI !== "0"
      ? geminiModels.map(model => ({ id: `gemini/${model}`, provider: "gemini", model })) : []),
    { id: "openrouter/free", provider: "openrouter", model: "openrouter/free" },
  ].map(lane => ({ ...lane, cooldownUntil: 0, reason: null, ok: 0, failed: 0 }));
  const tokens = new Map();
  const signatures = createSignatureCache();
  const tier = { state: geminiKey ? "unverified" : "absent", checkedAt: 0, inFlight: null };
  let server = null;
  let listening = null;
  let baseUrl = null;

  function emit(entry) {
    try { log({ tag: "freepool", ...entry }); } catch { /* never fail on logging */ }
  }

  async function verifyGeminiTier(force = false) {
    if (!geminiKey) return false;
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
    return lane.provider !== "gemini" || tier.state === "free";
  }

  function availableLanes(preferred) {
    const t = now();
    const ready = lanes.filter(lane => laneEnabled(lane) && lane.cooldownUntil <= t);
    const sticky = ready.find(lane => lane.id === preferred);
    return sticky ? [sticky, ...ready.filter(lane => lane !== sticky)] : ready;
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
    if (geminiKey && tier.state !== "free") await verifyGeminiTier();
    const attempted = [];
    let lastFailure = null;
    for (const lane of availableLanes(grant.lane)) {
      if (clientAbort.signal.aborted) return res.end();
      const started = now();
      const upstream = upstreamRequest(lane, body, grant, req.headers);
      const headerTimer = new AbortController();
      const timer = setTimeout(() => headerTimer.abort(), headerTimeoutMs);
      timer.unref?.();
      let response;
      try {
        response = await fetchImpl(upstream.url, {
          method: "POST",
          headers: upstream.headers,
          body: JSON.stringify(upstream.body),
          signal: AbortSignal.any([clientAbort.signal, headerTimer.signal]),
        });
      } catch (error) {
        clearTimeout(timer);
        if (clientAbort.signal.aborted) return res.end();
        const verdict = { failover: true, cooldownUntil: now() + TRANSIENT_COOLDOWN_MS, reason: "network",
          message: String(error?.message ?? error).slice(0, 200) };
        coolDown(lane, verdict);
        attempted.push(`${lane.id}:network`);
        lastFailure = { status: 503, message: verdict.message };
        continue;
      }
      clearTimeout(timer);
      if (!response.ok) {
        const text = await response.text().catch(() => "");
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
      lane.ok += 1;
      grant.lane = lane.id;
      res.writeHead(200, {
        "Content-Type": response.headers.get("content-type") ?? "application/json",
        "Cache-Control": "no-cache",
        "X-Free-Pool-Lane": lane.id,
      });
      let tail = "";
      try {
        for await (const chunk of response.body) {
          const text = Buffer.from(chunk).toString("utf8");
          if (lane.provider === "gemini") {
            const combined = tail + text;
            const cut = combined.lastIndexOf("\n");
            if (cut >= 0) {
              recordResponseSignatures(combined.slice(0, cut));
              tail = combined.slice(cut + 1);
            } else {
              tail = combined;
            }
          }
          if (!res.write(chunk)) await new Promise(resolve => res.once("drain", resolve));
        }
        if (tail) recordResponseSignatures(tail);
      } catch (error) {
        emit({ event: "stream_error", runId: grant.runId, lane: lane.id, message: String(error?.message ?? error).slice(0, 200) });
      }
      res.end();
      emit({ event: "request", runId: grant.runId, agentId: grant.agentId, lane: lane.id, status: 200,
        ms: now() - started, attempted });
      return undefined;
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
    if (geminiKey) void verifyGeminiTier();
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
        lanes: lanes.map(({ id, cooldownUntil, reason, ok, failed }) => ({
          id, enabled: laneEnabled(lanes.find(lane => lane.id === id)),
          cooldownUntil: cooldownUntil > now() ? new Date(cooldownUntil).toISOString() : null, reason, ok, failed,
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
