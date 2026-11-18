import * as piRuntime from "@paperclipai/adapter-pi-local/server";
import { randomUUID } from "node:crypto";
import { createCatalog } from "./catalog.mjs";

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
    const maxOutputTokens = config.maxOutputTokens ?? 4096;
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) {
      throw new Error("OpenRouter maxOutputTokens must be a positive integer.");
    }
    model.maxTokens = Math.min(model.maxTokens, maxOutputTokens);
    const thinking = config.thinking || "off";
    if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(thinking)) {
      throw new Error("OpenRouter thinking must be off, minimal, low, medium, high or xhigh.");
    }
    if (thinking !== "off" && !model.reasoning) {
      throw new Error("The selected OpenRouter model does not advertise reasoning support. Set thinking to off.");
    }
    const timeoutSec = config.timeoutSec ?? 300;
    if (typeof timeoutSec !== "number" || !Number.isFinite(timeoutSec) || timeoutSec <= 0) {
      throw new Error("OpenRouter timeoutSec must be a positive number.");
    }
    return {
      ...config,
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
            hint: "Tool-capable OpenRouter models. Add OPENROUTER_API_KEY through the environment editor using a secret reference.",
          },
          {
            key: "thinking", label: "Thinking", type: "select", default: "off",
            options: ["off", "minimal", "low", "medium", "high", "xhigh"].map(value => ({ value, label: value })),
            hint: "Use off unless the selected model supports reasoning.",
          },
          { key: "cwd", label: "Working directory", type: "text" },
          { key: "instructionsFilePath", label: "Instructions file", type: "text" },
          { key: "promptTemplate", label: "Prompt template", type: "textarea" },
          { key: "timeoutSec", label: "Run timeout (seconds)", type: "number", default: 300 },
          { key: "maxOutputTokens", label: "Maximum output tokens per turn", type: "number", default: 4096 },
          { key: "graceSec", label: "Termination grace (seconds)", type: "number", default: 20 },
        ],
      };
    },
    async execute(ctx) {
      let config;
      try {
        config = await prepareConfig(ctx.config);
      } catch (error) {
        const message = errorText(error);
        await ctx.onLog("stderr", `${message}\n`);
        return {
          exitCode: 1, signal: null, timedOut: false,
          errorCode: "configuration_incomplete", errorMessage: message,
        };
      }
      return runtime.execute({
        ...ctx, config,
        onMeta: ctx.onMeta ? meta => ctx.onMeta({ ...meta, adapterType: "openrouter" }) : undefined,
      });
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
            code: "openrouter_hello_probe", level: hello ? "info" : "warn",
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
