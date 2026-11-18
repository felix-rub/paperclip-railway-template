import { writeFileSync } from "node:fs";
import { COMPACT_PROMPT, createGuard, createIssueTools, routeRequest } from "./policy.mjs";

export default function policyExtension(pi) {
  const policy = JSON.parse(process.env.PAPERCLIP_OPENROUTER_POLICY || '{"compact":false}');
  const state = {};
  const persist = () => writeFileSync(policy.outcome, JSON.stringify(state), { mode: 0o600 });
  const guard = createGuard(policy, state);
  pi.on("before_provider_request", ({ payload }) => routeRequest(payload));
  if (!policy.compact) return;

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
    guard.afterMessage(message);
    if (state.stop) {
      persist();
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
