import * as piRuntime from "@paperclipai/adapter-pi-local/server";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCatalog } from "./catalog.mjs";
import { COMPACT_PROMPT } from "./policy.mjs";

const POLICY_PATH = fileURLToPath(new URL("./pi-policy.mjs", import.meta.url));
const GUARD_STOPS = new Set(["openrouter_tool_loop", "openrouter_tool_budget", "openrouter_input_budget"]);

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

Select OpenRouter as the agent adapter and choose a tool-capable model.
Model IDs are OpenRouter slugs, for example anthropic/claude-sonnet-4.5.
Set OPENROUTER_API_KEY in the agent environment using a Paperclip secret reference,
or configure it on the server. Never enter a key in a prompt or model field.

OpenRouter is the only model provider. Pi supplies the agent/tool loop, workspace
tools, instructions, skill injection, usage receipts and resumable sessions.
OpenCode, Codex and Claude Code are not used by this adapter.

Use the environment editor for secrets; this external adapter does not impersonate
a built-in adapter to bypass managed AI-connection compatibility checks.
Do not bind a managed AI account to this adapter; use OPENROUTER_API_KEY instead.
Other adapters and existing agents are unchanged.
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

export function createServerAdapter({ runtime = piRuntime, fetchImpl = fetch } = {}) {
  const catalog = createCatalog(fetchImpl);
  async function prepareConfig(config) {
    if ((Array.isArray(config.extraArgs) && config.extraArgs.length) ||
        (Array.isArray(config.args) && config.args.length)) {
      throw new Error("OpenRouter does not accept extra CLI arguments; configure model and thinking through the adapter fields.");
    }
    const env = prepareEnvironment(config);
    const model = await catalog.resolve(config.model);
    const maxOutputTokens = positiveInt(config.maxOutputTokens, "OpenRouter maxOutputTokens", 4096);
    model.maxTokens = Math.min(model.maxTokens, maxOutputTokens);
    const thinking = config.thinking || "off";
    if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(thinking)) {
      throw new Error("OpenRouter thinking must be off, minimal, low, medium, high or xhigh.");
    }
    if (thinking !== "off" && !model.reasoning) {
      throw new Error("The selected OpenRouter model does not advertise reasoning support. Set thinking to off.");
    }
    const profile = config.profile ?? "standard";
    if (!["standard", "compact"].includes(profile)) throw new Error("OpenRouter profile must be standard or compact.");
    const timeoutSec = config.timeoutSec ?? (profile === "compact" ? 600 : 300);
    if (typeof timeoutSec !== "number" || !Number.isFinite(timeoutSec) || timeoutSec <= 0) {
      throw new Error("OpenRouter timeoutSec must be a positive number.");
    }
    return {
      ...config,
      profile,
      command: "pi",
      model: `openrouter/${model.id}`,
      thinking,
      timeoutSec,
      env: {
        ...env,
        PAPERCLIP_PI_PROVIDERS: JSON.stringify({
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai-completions",
            apiKey: "OPENROUTER_API_KEY",
            models: [model],
          },
        }),
      },
    };
  }
  async function preparePolicy(config, ctx) {
    const compact = config.profile === "compact" && Boolean(ctx.context?.taskId || ctx.context?.issueId);
    const fallbackList = config.fallbackModels ?? "";
    if (typeof fallbackList !== "string") throw new Error("OpenRouter fallbacks must be a comma-separated model list.");
    const requested = fallbackList.split(/[,\n]/).map(id => id.trim()).filter(Boolean);
    if (requested.length > 3) throw new Error("Configure at most three OpenRouter fallbacks.");
    const fallbacks = (await Promise.all(requested.map(id => catalog.resolve(id))))
      .filter(model => config.model !== `openrouter/${model.id}`);
    const fallbackModels = [...new Set(fallbacks.map(model => model.id))];
    if (config.escalationModel != null && typeof config.escalationModel !== "string") {
      throw new Error("Escalation model must be text.");
    }
    const escalation = compact && config.escalationModel?.trim() ? await catalog.resolve(config.escalationModel) : null;
    if (escalation && config.model === `openrouter/${escalation.id}`) {
      throw new Error("Escalation requires a different model.");
    }
    if (config.verificationCommand != null && typeof config.verificationCommand !== "string") {
      throw new Error("Verification command must be text.");
    }
    if ((compact || fallbackModels.length) && ctx.executionTarget?.kind === "remote") {
      throw new Error("OpenRouter compact mode and fallback routing currently require the local Railway runtime.");
    }
    if (fallbacks.length) {
      const providers = JSON.parse(config.env.PAPERCLIP_PI_PROVIDERS);
      const primary = providers.openrouter.models[0];
      primary.contextWindow = Math.min(primary.contextWindow, ...fallbacks.map(model => model.contextWindow));
      primary.maxTokens = Math.min(primary.maxTokens, ...fallbacks.map(model => model.maxTokens));
      config.env.PAPERCLIP_PI_PROVIDERS = JSON.stringify(providers);
    }
    return {
      compact, fallbackModels, escalation,
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
      const { escalation, ...settings } = policy;
      const attempt = {
        ...config,
        ...(policy.compact ? {
          promptTemplate: COMPACT_PROMPT,
          extraArgs: ["--no-extensions", "--no-skills", "--tools",
            "read,bash,edit,write,grep,find,ls,paperclip_get_task,paperclip_comment,paperclip_set_status"],
        } : { extraArgs: [] }),
        env: {
          ...config.env,
          PAPERCLIP_OPENROUTER_POLICY: JSON.stringify({ ...settings, outcome }),
        },
      };
      if (policy.compact) {
        for (const key of ["PAPERCLIP_API_URL", "PAPERCLIP_API_KEY", "PAPERCLIP_RUN_ID", "PAPERCLIP_TASK_ID"]) delete attempt.env[key];
      }
      attempt.extraArgs.push("--extension", POLICY_PATH);
      const result = await runtime.execute({ ...ctx, config: attempt });
      if (!policy.compact) return { result, state: {} };
      let state;
      try {
        state = JSON.parse(await readFile(outcome, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return { result: result.exitCode === 0 ? failResult("openrouter_policy_unavailable", "Compact policy did not initialize.", result) : result, state: {} };
      }
      if (state.terminal && !result.timedOut && !result.signal) {
        return { result: { ...result, exitCode: 0, errorCode: null, errorMessage: null, summary: "" }, state };
      }
      if (state.stop) {
        return { result: failResult(state.stop, "OpenRouter compact policy stopped this run before any further work.", result), state };
      }
      if (result.exitCode === 0) {
        return { result: failResult("openrouter_issue_unfinished", "Model exited without recording a verified issue outcome.", result), state };
      }
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
    listModels: () => catalog.list(),
    refreshModels: () => catalog.list(true),
    getRuntimeCommandSpec: () => ({
      command: "pi",
      detectCommand: "pi",
      installCommand: INSTALL_COMMAND,
    }),
    async getConfigSchema() {
      return {
        fields: [
          {
            key: "model", label: "OpenRouter model", type: "combobox", required: true,
            options: (await catalog.list()).map(model => ({ value: model.id, label: model.label })),
            hint: "Add OPENROUTER_API_KEY as a secret reference. Free models can be rate-limited and are best for smoke tests.",
          },
          { key: "profile", label: "Execution profile", type: "select", default: "standard",
            options: [{ value: "standard", label: "Standard" }, { value: "compact", label: "Compact (issue runs)" }] },
          { key: "verificationCommand", label: "Compact verification command", type: "text",
            hint: "Operator-reviewed shell check. Compact tools cannot mark done without a passing check." },
          { key: "maxToolCalls", label: "Compact tool-call budget", type: "number", default: 30 },
          { key: "maxRunInputTokens", label: "Compact input-token budget per attempt", type: "number", default: 80000 },
          { key: "fallbackModels", label: "Fallback models (comma-separated)", type: "text" },
          { key: "escalationModel", label: "Escalation model (optional)", type: "text",
            hint: "One extra attempt if the first did not finish and made no changes." },
          {
            key: "thinking", label: "Thinking", type: "select", default: "off",
            options: ["off", "minimal", "low", "medium", "high", "xhigh"].map(value => ({ value, label: value })),
            hint: "Use off unless the selected model supports reasoning.",
          },
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
        config = await prepareConfig(ctx.config);
        policy = await preparePolicy(config, ctx);
      } catch (error) {
        const message = errorText(error);
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
      if (!policy.compact && !policy.fallbackModels.length) return runtime.execute(forwarded);
      const started = Date.now();
      const { result, state } = await runPolicy(forwarded, config, policy);
      if (!policy.escalation || !ctx.onUsage || ctx.signal?.aborted || result.timedOut ||
          state.workAttempted || state.wroteComment || state.statusAttempted ||
          (!GUARD_STOPS.has(result.errorCode) && result.errorCode !== "openrouter_issue_unfinished")) return result;
      const timeoutSec = config.timeoutSec - (Date.now() - started) / 1000;
      if (timeoutSec < 5) return result;
      await ctx.onLog("stdout", "[paperclip] OpenRouter escalating once; no work or issue update was attempted.\n");
      const next = await prepareConfig({
        ...ctx.config, model: policy.escalation.id, thinking: "off", timeoutSec,
      });
      const retry = await runPolicy({ ...forwarded, runtime: { ...ctx.runtime, sessionId: null, sessionParams: null } }, next, {
        ...policy, escalation: null, fallbackModels: [],
      });
      return retry.result;
    },
    async testEnvironment(ctx) {
      let config;
      try {
        config = await prepareConfig(ctx.config);
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
            env: { ...config.env, PAPERCLIP_PI_PROVIDERS: JSON.stringify(providers) },
            promptTemplate: "Respond with exactly hello. Do not use tools or perform any other work.",
            extraArgs: ["--tools", "read", "--no-session"],
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
