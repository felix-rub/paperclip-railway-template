import { writeFileSync } from "node:fs";
import { COMPACT_PROMPT, createGuard, createIssueTools, routeRequest } from "./policy.mjs";

export default function policyExtension(pi) {
  const policy = JSON.parse(process.env.PAPERCLIP_OPENROUTER_POLICY || '{"compact":false}');
  const state = {
    providerTelemetry: {
      requestsSent: 0,
      requestedModel: null,
      lastModel: null,
      lastStopReason: null,
      responseId: null,
      lastError: null,
    },
  };
  const persist = () => {
    if (policy.outcome) writeFileSync(policy.outcome, JSON.stringify(state), { mode: 0o600 });
  };
  const recordMessageTelemetry = (message) => {
    if (!message || typeof message !== "object") return;
    if (typeof message.model === "string" && message.model) {
      state.providerTelemetry.lastModel = message.model;
    }
    if (typeof message.stopReason === "string" && message.stopReason) {
      state.providerTelemetry.lastStopReason = message.stopReason;
    }
    const responseId = message.responseId ?? message.id;
    if (typeof responseId === "string" && responseId) {
      state.providerTelemetry.responseId = responseId;
    }
    if (typeof message.errorMessage === "string" && message.errorMessage) {
      state.providerTelemetry.lastError = message.errorMessage.slice(0, 300);
    }
  };
  persist();
  const guard = createGuard(policy, state);
  pi.on("before_provider_request", ({ payload }) => {
    const routed = routeRequest(payload);
    state.providerTelemetry.requestsSent += 1;
    if (typeof payload?.model === "string" && payload.model) {
      state.providerTelemetry.requestedModel = payload.model;
    }
    persist();
    return routed;
  });
  if (!policy.compact) {
    pi.on("message_end", ({ message }) => {
      recordMessageTelemetry(message);
      persist();
    });
    pi.on("agent_end", persist);
    return;
  }

  const issue = createIssueTools({
    env: process.env, issueId: policy.issueId, verificationCommand: policy.verificationCommand, state, persist,
  });
  if (!issue) {
    state.stop = "openrouter_issue_tools_unavailable";
    persist();
  }
  pi.on("before_agent_start", event => {
    const systemPrompt = event.systemPrompt.replace(/<available_skills>[\s\S]*?<\/available_skills>/g, "");
    return { systemPrompt: systemPrompt.includes(COMPACT_PROMPT) ? systemPrompt : `${systemPrompt}\n\n${COMPACT_PROMPT}` };
  });
  pi.on("tool_call", event => {
    const result = guard.beforeTool(event);
    if (state.workAttempted || result) persist();
    return result;
  });
  pi.on("context", (_, ctx) => {
    if (state.stop || state.terminal) ctx.abort();
  });
  pi.on("message_end", ({ message }, ctx) => {
    recordMessageTelemetry(message);
    guard.afterMessage(message);
    persist();
    if (state.stop) {
      ctx.abort();
    }
  });
  pi.on("tool_execution_end", (event, ctx) => {
    guard.afterTool(event);
    if (state.stop || state.terminal) {
      persist();
      ctx.abort();
    }
  });
  pi.on("agent_end", persist);
  if (!issue) return;

  const text = { type: "string" };
  function register(name, description, properties, execute) {
    pi.registerTool({
      name, label: name, description,
      executionMode: "sequential",
      parameters: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
      async execute(_id, args) {
        const result = await execute(args);
        persist();
        return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] };
      },
    });
  }
  register("paperclip_get_task", "Read the current issue and its configured check.", {}, issue.getTask);
  register("paperclip_comment", "Post one progress note if not submitting a final status.", { body: text }, issue.comment);
  register("paperclip_set_status", "Set done or blocked and record evidence on the current issue.", {
    status: { type: "string", enum: ["done", "blocked"] }, evidence: text,
  }, issue.setStatus);
}
