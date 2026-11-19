import * as piRuntime from "@paperclipai/adapter-pi-local/server";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCatalog } from "./catalog.mjs";
import { COMPACT_PROMPT } from "./policy.mjs";

const POLICY_PATH = fileURLToPath(new URL("./pi-policy.mjs", import.meta.url));
const FREE_MODEL = "openrouter/free";
const KEY_URL = "https://openrouter.ai/api/v1/key";
const KEY_VERIFY_TTL_MS = 60_000;

export function resolveDefaultPiCommand() {
  const binName = process.platform === "win32" ? "pi.cmd" : "pi";
  const bundled = fileURLToPath(new URL(`../../node_modules/.bin/${binName}`, import.meta.url));
  return existsSync(bundled) ? bundled : "pi";
}

function positiveInt(value, field, fallback) {
  const parsed = value ?? fallback;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${field} must be a positive integer.`);
  return parsed;
}

function failResult(errorCode, errorMessage, result = {}) {
  return { ...result, exitCode: 1, signal: null, timedOut: false, errorCode, errorMessage };
}

const INSTALL_COMMAND = "npm install -g @earendil-works/pi-coding-agent@0.78.1";
const DOC = `# OpenRouter adapter

Select OpenRouter as the agent adapter. All runs use openrouter/free.
Saved model choices, paid fallbacks and escalation models are ignored.
Failed runs wait one hour, then resume automatically without an attempt limit.
Set OPENROUTER_API_KEY in the agent environment using a Paperclip secret reference,
or configure it on the server. Never enter a key in a prompt or model field.

OpenRouter is the only model provider. Pi supplies the agent/tool loop, workspace
tools, instructions, skill injection, usage receipts and resumable sessions.
OpenCode, Codex and Claude Code are not used by this adapter.

Use the environment editor for secrets; this external adapter does not impersonate
a built-in adapter to bypass managed AI-connection compatibility checks.
Do not bind a managed AI account to this adapter; use OPENROUTER_API_KEY instead.
Other adapter types and their agents are unchanged.
`;

function errorText(error) {
  return error instanceof Error ? error.message : "OpenRouter adapter configuration failed.";
}

function prepareEnvironment(config) {
  const env = config.env ?? {};
  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    throw new Error("OpenRouter adapter env must be an object.");
  }
  const key = Object.hasOwn(env, "OPENROUTER_API_KEY")
    ? env.OPENROUTER_API_KEY : process.env.OPENROUTER_API_KEY;
  if (typeof key !== "string" || !key.trim()) {
    throw new Error("OPENROUTER_API_KEY is missing. Add an agent secret reference or a server environment variable.");
  }
  return { ...env, OPENROUTER_API_KEY: key.trim() };
}

const DEFAULT_PRODUCTION_START_INTERVAL_MS = 3_500;

function createStartPacer() {
  let nextAllowedAt = 0;
  let gate = Promise.resolve();
  return function waitForStartSlot(intervalMs, signal) {
    if (intervalMs <= 0) return Promise.resolve();
    const turn = gate.then(async () => {
      if (signal?.aborted) return;
      const waitMs = nextAllowedAt - Date.now();
      if (waitMs > 0) {
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            if (signal) signal.removeEventListener("abort", onAbort);
            resolve();
          }, waitMs);
          timer.unref?.();
          function onAbort() {
            clearTimeout(timer);
            resolve();
          }
          if (signal) {
            if (signal.aborted) {
              onAbort();
              return;
            }
            signal.addEventListener("abort", onAbort, { once: true });
          }
        });
      }
      if (!signal?.aborted) {
        nextAllowedAt = Date.now() + intervalMs;
      }
    });
    gate = turn.then(() => undefined, () => undefined);
    return turn;
  };
}

const sharedStartPacer = createStartPacer();

function resolveMinStartIntervalMs(explicitMs, isDefaultFetch, env = process.env) {
  if (explicitMs !== undefined) {
    if (!Number.isSafeInteger(explicitMs) || explicitMs < 0) {
      throw new Error("OpenRouter minStartIntervalMs must be a non-negative integer.");
    }
    return explicitMs;
  }
  const raw = env?.OPENROUTER_MIN_START_INTERVAL_MS;
  if (raw !== undefined && raw !== "") {
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  return isDefaultFetch ? DEFAULT_PRODUCTION_START_INTERVAL_MS : 0;
}

function redactSecrets(value, extraSecret = "") {
  if (typeof value !== "string" || !value) return null;
  let out = value
    .replace(/sk-or-v1-[a-zA-Z0-9_-]+/g, "[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]");
  if (typeof extraSecret === "string" && extraSecret.trim().length >= 8) {
    out = out.split(extraSecret.trim()).join("[REDACTED]");
  }
  return out.slice(0, 300);
}

export function createServerAdapter({ runtime = piRuntime, fetchImpl = fetch, minStartIntervalMs, onTelemetry, piCommand } = {}) {
  const catalog = createCatalog(fetchImpl);
  const isDefaultFetch = fetchImpl === fetch;
  const defaultPiCommand = piCommand ?? resolveDefaultPiCommand();
  const waitForStartSlot = minStartIntervalMs === undefined ? sharedStartPacer : createStartPacer();
  const emitTelemetry = typeof onTelemetry === "function" ? onTelemetry : (entry) => console.log(JSON.stringify(entry));
  const keyVerifyCache = new Map();

  async function verifyApiKey(apiKey) {
    const keyDigest = createHash("sha256").update(apiKey).digest("hex");
    const now = Date.now();
    const cached = keyVerifyCache.get(keyDigest);
    if (cached && cached.expiresAt > now) {
      return { ok: true };
    }
    let response;
    try {
      response = await fetchImpl(KEY_URL, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": "https://paperclip.ing",
          "X-Title": "Paperclip",
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      return {
        ok: false,
        code: "openrouter_key_probe_unavailable",
        retryable: true,
        message: redactSecrets(errorText(error), apiKey) ?? "OpenRouter key verification failed.",
      };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        code: "openrouter_hello_probe_auth_required",
        retryable: false,
        message: "OpenRouter rejected OPENROUTER_API_KEY.",
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        code: "openrouter_key_probe_unavailable",
        retryable: true,
        message: `OpenRouter key verification returned HTTP ${response.status}.`,
      };
    }
    keyVerifyCache.set(keyDigest, { expiresAt: now + KEY_VERIFY_TTL_MS });
    return { ok: true };
  }

  async function prepareConfig(config, options = {}) {
    if ((Array.isArray(config.extraArgs) && config.extraArgs.length) ||
        (Array.isArray(config.args) && config.args.length)) {
      throw new Error("OpenRouter does not accept extra CLI arguments; free routing is managed by the server.");
    }
    const env = prepareEnvironment(config);
    const model = await catalog.resolve(FREE_MODEL);
    if (model.cost.input !== 0 || model.cost.output !== 0) {
      throw new Error("OpenRouter's free router no longer reports zero pricing; refusing paid inference.");
    }
    const maxOutputTokens = positiveInt(config.maxOutputTokens, "OpenRouter maxOutputTokens", 4096);
    model.maxTokens = Math.min(model.maxTokens, maxOutputTokens);
    const thinking = "off";
    const profile = config.profile ?? "standard";
    if (!["standard", "compact"].includes(profile)) throw new Error("OpenRouter profile must be standard or compact.");
    const defaultTimeoutSec = profile === "compact" ? 600 : 300;
    const timeoutSec = config.timeoutSec === 0 ? defaultTimeoutSec : (config.timeoutSec ?? defaultTimeoutSec);
    if (typeof timeoutSec !== "number" || !Number.isFinite(timeoutSec) || timeoutSec <= 0) {
      throw new Error("OpenRouter timeoutSec must be a positive number.");
    }
    return {
      ...config,
      fallbackModels: "",
      escalationModel: "",
      profile,
      command: options.executionTarget?.kind === "ssh" ? "pi" : defaultPiCommand,
      model: `openrouter/${model.id}`,
      thinking,
      timeoutSec,
      env: {
        ...env,
        PAPERCLIP_OPENROUTER_FREE_ONLY: "1",
        PAPERCLIP_PI_PROVIDERS: JSON.stringify({
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai-completions",
            apiKey: "{env:OPENROUTER_API_KEY}",
            models: [model, ...(model.id === FREE_MODEL ? [{ ...model, id: "free" }] : [])],
          },
        }),
      },
    };
  }
  async function preparePolicy(config, ctx) {
    const compact = config.profile === "compact" && Boolean(ctx.context?.taskId || ctx.context?.issueId);
    if (config.verificationCommand != null && typeof config.verificationCommand !== "string") {
      throw new Error("Verification command must be text.");
    }
    if (ctx.executionTarget?.kind === "remote") {
      throw new Error("OpenRouter's enforced free-routing policy requires the local Railway runtime.");
    }
    return {
      compact,
      issueId: ctx.context?.taskId || ctx.context?.issueId,
      verificationCommand: config.verificationCommand?.trim(),
      maxToolCalls: positiveInt(config.maxToolCalls, "OpenRouter maxToolCalls", 30),
      maxRunInputTokens: positiveInt(config.maxRunInputTokens, "OpenRouter maxRunInputTokens", 80_000),
    };
  }

  async function runPolicy(ctx, config, policy) {
    const dir = await mkdtemp(join(tmpdir(), "paperclip-openrouter-"));
    const outcome = join(dir, "outcome.json");
    try {
      const attempt = {
        ...config,
        ...(policy.compact ? {
          promptTemplate: COMPACT_PROMPT,
          extraArgs: ["--no-extensions", "--no-skills", "--tools",
            "read,bash,edit,write,grep,find,ls,paperclip_get_task,paperclip_comment,paperclip_set_status"],
        } : { extraArgs: ["--no-extensions"] }),
        env: {
          ...config.env,
          PAPERCLIP_OPENROUTER_POLICY: JSON.stringify({ ...policy, outcome }),
        },
      };
      if (policy.compact) {
        for (const key of ["PAPERCLIP_API_URL", "PAPERCLIP_API_KEY", "PAPERCLIP_RUN_ID", "PAPERCLIP_TASK_ID"]) delete attempt.env[key];
      }
      attempt.extraArgs.push("--extension", POLICY_PATH);
      const startIntervalMs = resolveMinStartIntervalMs(minStartIntervalMs, isDefaultFetch);
      await waitForStartSlot(startIntervalMs, ctx.signal);
      if (ctx.signal?.aborted) {
        return {
          result: { exitCode: 1, signal: "SIGTERM", timedOut: false, errorCode: "cancelled", errorMessage: "Run aborted before execution." },
          state: {},
        };
      }
      let state = null;
      const readOutcomeState = async (ignoreInvalid = false) => {
        try {
          state = JSON.parse(await readFile(outcome, "utf8"));
        } catch (error) {
          if (error.code !== "ENOENT" && !ignoreInvalid) throw error;
        }
      };
      const recordInvokeTelemetry = (finalResult) => {
        const providerTelemetry = state?.providerTelemetry ?? null;
        try {
          emitTelemetry({
            tag: "openrouter.invoke",
            runId: ctx.runId ?? null,
            agentId: ctx.agent?.id ?? null,
            companyId: ctx.agent?.companyId ?? null,
            profile: policy.compact ? "compact" : "standard",
            providerRequests: Number(providerTelemetry?.requestsSent ?? 0),
            requestedModel: providerTelemetry?.requestedModel ?? config.model ?? null,
            routedModel: finalResult?.provider || providerTelemetry?.lastModel || null,
            exitCode: finalResult?.exitCode ?? null,
            timedOut: Boolean(finalResult?.timedOut),
            errorCode: finalResult?.errorCode ?? null,
            stopReason: providerTelemetry?.lastStopReason ?? null,
            responseId: providerTelemetry?.responseId ?? null,
            lastError: redactSecrets(providerTelemetry?.lastError ?? finalResult?.errorMessage ?? null, config.env?.OPENROUTER_API_KEY),
          });
        } catch {
          // Never fail execution due to telemetry logging.
        }
      };
      let result;
      try {
        result = await runtime.execute({ ...ctx, config: attempt });
      } catch (error) {
        await readOutcomeState(true);
        const redacted = redactSecrets(errorText(error), config.env?.OPENROUTER_API_KEY) ?? "OpenRouter runtime execution failed.";
        await ctx.onLog?.("stderr", `${redacted}\n`);
        const crashed = failResult("adapter_failed", redacted);
        recordInvokeTelemetry(crashed);
        return { result: crashed, state: state ?? {} };
      }
      await readOutcomeState(false);
      if (!policy.compact) {
        recordInvokeTelemetry(result);
        return { result, state: state ?? {} };
      }
      if (!state) {
        const failed = result.exitCode === 0 ? failResult("openrouter_policy_unavailable", "Compact policy did not initialize.", result) : result;
        recordInvokeTelemetry(failed);
        return { result: failed, state: {} };
      }
      if (state.terminal && !result.timedOut && !result.signal) {
        const okResult = { ...result, exitCode: 0, errorCode: null, errorMessage: null, summary: "" };
        recordInvokeTelemetry(okResult);
        return { result: okResult, state };
      }
      if (state.stop) {
        const stopped = failResult(state.stop, "OpenRouter compact policy stopped this run before any further work.", result);
        recordInvokeTelemetry(stopped);
        return { result: stopped, state };
      }
      if (result.exitCode === 0) {
        const unfinished = failResult("openrouter_issue_unfinished", "Model exited without recording a verified issue outcome.", result);
        recordInvokeTelemetry(unfinished);
        return { result: unfinished, state };
      }
      recordInvokeTelemetry(result);
      return { result, state };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  return {
    type: "openrouter",
    runtimeToolDelivery: "environment",
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    requiresMaterializedRuntimeSkills: true,
    supportsToolRefreshOnResume: true,
    sessionCodec: runtime.sessionCodec,
    listSkills: runtime.listPiSkills,
    syncSkills: runtime.syncPiSkills,
    agentConfigurationDoc: DOC,
    models: [],
    listModels: async () => (await catalog.list()).filter(model => model.id === FREE_MODEL),
    refreshModels: async () => (await catalog.list(true)).filter(model => model.id === FREE_MODEL),
    getRuntimeCommandSpec: () => ({
      command: defaultPiCommand,
      detectCommand: defaultPiCommand,
      installCommand: INSTALL_COMMAND,
    }),
    async getConfigSchema() {
      return {
        fields: [
          {
            key: "model", label: "OpenRouter model (free only)", type: "select", default: FREE_MODEL,
            options: [{ value: FREE_MODEL, label: "OpenRouter Free (enforced)" }],
            hint: "Always openrouter/free. Failures retry hourly without an attempt limit; no paid fallback.",
          },
          { key: "profile", label: "Execution profile", type: "select", default: "standard",
            options: [{ value: "standard", label: "Standard" }, { value: "compact", label: "Compact (issue runs)" }] },
          { key: "verificationCommand", label: "Compact verification command", type: "text",
            hint: "Operator-reviewed shell check. Compact tools cannot mark done without a passing check." },
          { key: "maxToolCalls", label: "Compact tool-call budget", type: "number", default: 30 },
          { key: "maxRunInputTokens", label: "Compact input-token budget per attempt", type: "number", default: 80000 },
          { key: "cwd", label: "Working directory", type: "text" },
          { key: "instructionsFilePath", label: "Instructions file", type: "text" },
          { key: "promptTemplate", label: "Prompt template", type: "textarea" },
          { key: "timeoutSec", label: "Run timeout (seconds)", type: "number", hint: "Defaults: standard 300s, compact 600s." },
          { key: "maxOutputTokens", label: "Maximum output tokens per turn", type: "number", default: 4096 },
          { key: "graceSec", label: "Termination grace (seconds)", type: "number", default: 20 },
        ],
      };
    },
    async execute(ctx) {
      let config;
      let policy;
      try {
        config = await prepareConfig(ctx.config, { executionTarget: ctx.executionTarget });
        policy = await preparePolicy(config, ctx);
      } catch (error) {
        const message = redactSecrets(errorText(error), ctx.config?.env?.OPENROUTER_API_KEY) ?? errorText(error);
        await ctx.onLog("stderr", `${message}\n`);
        return {
          exitCode: 1, signal: null, timedOut: false,
          errorCode: "configuration_incomplete", errorMessage: message,
        };
      }
      const forwarded = {
        ...ctx, config,
        onMeta: ctx.onMeta ? meta => ctx.onMeta({ ...meta, adapterType: "openrouter" }) : undefined,
      };
      return (await runPolicy(forwarded, config, policy)).result;
    },
    async testEnvironment(ctx) {
      let config;
      try {
        config = await prepareConfig(ctx.config, { executionTarget: ctx.executionTarget });
        if (runtime === piRuntime && ctx.executionTarget?.kind !== "ssh") {
          const keyCheck = await verifyApiKey(config.env.OPENROUTER_API_KEY);
          if (!keyCheck.ok) {
            return {
              adapterType: "openrouter",
              status: "fail",
              checks: [{
                code: keyCheck.code,
                level: "error",
                ...(keyCheck.retryable ? { retryable: true } : {}),
                message: keyCheck.message,
              }],
              testedAt: new Date().toISOString(),
            };
          }
          try {
            await piRuntime.ensurePiModelConfiguredAndAvailable({
              model: config.model,
              command: config.command,
              cwd: config.cwd || process.cwd(),
              env: config.env,
            });
          } catch (error) {
            return {
              adapterType: "openrouter",
              status: "fail",
              checks: [{
                code: "openrouter_hello_probe_model_unavailable",
                level: "error",
                message: redactSecrets(errorText(error), config.env.OPENROUTER_API_KEY) ?? "Configured Pi model is unavailable.",
              }],
              testedAt: new Date().toISOString(),
            };
          }
          return {
            adapterType: "openrouter",
            status: "pass",
            checks: [{
              code: "openrouter_hello_probe_passed",
              level: "info",
              message: "OpenRouter API key, $0 openrouter/free catalog entry, and bundled Pi CLI model availability verified.",
            }],
            testedAt: new Date().toISOString(),
          };
        }
        const providers = JSON.parse(config.env.PAPERCLIP_PI_PROVIDERS);
        providers.openrouter.models[0].maxTokens = Math.min(providers.openrouter.models[0].maxTokens, 256);
        // Pi's standalone probe skips custom providers. Exercise the real
        // execution path so newly published models are tested correctly.
        const probe = await runtime.execute({
          runId: randomUUID(),
          agent: { id: "openrouter-environment-probe", name: "OpenRouter probe", companyId: ctx.companyId },
          runtime: { sessionId: null, sessionParams: null },
          context: {},
          executionTarget: ctx.executionTarget,
          config: {
            command: config.command, model: config.model, thinking: "off",
            cwd: config.cwd, timeoutSec: 60, graceSec: config.graceSec,
            env: { ...config.env, PAPERCLIP_PI_PROVIDERS: JSON.stringify(providers),
              PAPERCLIP_OPENROUTER_POLICY: '{"compact":false}' },
            promptTemplate: "Respond with exactly hello. Do not use tools or perform any other work.",
            extraArgs: ["--tools", "read", "--no-session", "--no-extensions", "--extension", POLICY_PATH],
          },
          onLog: async () => {},
        });
        if (probe.timedOut || probe.exitCode !== 0) {
          throw new Error(probe.errorMessage || "OpenRouter engine probe failed.");
        }
        const hello = /\bhello\b/i.test(probe.summary ?? "");
        return {
          adapterType: "openrouter", status: hello ? "pass" : "warn",
          checks: [{
            code: hello ? "openrouter_hello_probe_passed" : "openrouter_hello_probe_unexpected_output",
            level: hello ? "info" : "warn",
            message: hello ? "OpenRouter engine probe succeeded." : "OpenRouter responded without the expected hello.",
          }],
          testedAt: new Date().toISOString(),
        };
      } catch (error) {
        const key = config?.env.OPENROUTER_API_KEY;
        const message = errorText(error);
        return {
          adapterType: "openrouter", status: "fail",
          checks: [{
            code: "openrouter_configuration", level: "error",
            message: key ? message.split(key).join("[REDACTED]") : message,
          }],
          testedAt: new Date().toISOString(),
        };
      }
    },
  };
}
