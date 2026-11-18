import * as piRuntime from "@paperclipai/adapter-pi-local/server";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCatalog } from "./catalog.mjs";
import { COMPACT_PROMPT } from "./policy.mjs";

const POLICY_PATH = fileURLToPath(new URL("./pi-policy.mjs", import.meta.url));
const FREE_MODEL = "openrouter/free";

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

export function createServerAdapter({ runtime = piRuntime, fetchImpl = fetch } = {}) {
  const catalog = createCatalog(fetchImpl);
  async function prepareConfig(config) {
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
      command: "pi",
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
    listModels: async () => (await catalog.list()).filter(model => model.id === FREE_MODEL),
    refreshModels: async () => (await catalog.list(true)).filter(model => model.id === FREE_MODEL),
    getRuntimeCommandSpec: () => ({
      command: "pi",
      detectCommand: "pi",
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
      return (await runPolicy(forwarded, config, policy)).result;
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
