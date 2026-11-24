(() => {
  const id = "paperclip-openrouter-queue";
  const UUID = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;
  let companyId = "";
  let timer;

  function badge() {
    let element = document.getElementById(id);
    if (!element) {
      element = document.createElement("aside");
      element.id = id;
      element.setAttribute("role", "status");
      Object.assign(element.style, {
        position: "fixed",
        right: "16px",
        bottom: "16px",
        zIndex: "2147483647",
        maxWidth: "360px",
        border: "1px solid #52525b",
        borderRadius: "10px",
        background: "#18181b",
        color: "#fafafa",
        boxShadow: "0 8px 30px rgba(0,0,0,.35)",
        padding: "10px 12px",
        font: "12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace",
      });
      document.body.appendChild(element);
    }
    return element;
  }

  function compactDuration(milliseconds) {
    const minutes = Math.max(1, Math.ceil(Number(milliseconds || 300_000) / 60_000));
    if (minutes < 60) return `~${minutes}m`;
    return `~${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }

  function routeState() {
    const parts = location.pathname.split("/").filter(Boolean);
    const prefix = parts[0] ? decodeURIComponent(parts[0]).toUpperCase() : "";
    const agent = parts.find(part => UUID.test(part));
    const issueIdentifier = parts.includes("issues") ? parts[parts.indexOf("issues") + 1] : null;
    const runId = parts.includes("runs") ? parts[parts.indexOf("runs") + 1] : null;
    return { prefix, agent, issueIdentifier, runId };
  }

  async function resolveCompany(prefix) {
    if (companyId) return companyId;
    const response = await fetch("/api/companies", { credentials: "same-origin" });
    if (!response.ok) throw new Error(`Company lookup failed: HTTP ${response.status}`);
    const companies = await response.json();
    const match = companies.find(company => company.status === "active" &&
      String(company.issuePrefix || "").toUpperCase() === prefix);
    if (!match) return "";
    companyId = match.id;
    return companyId;
  }

  function statusText(run, data) {
    if (run.status === "running") return `${run.agentName}: running`;
    if (data.quotaCooldownUntil) {
      return `${run.agentName}: waiting for free quota until ${new Date(data.quotaCooldownUntil).toLocaleTimeString()}`;
    }
    if (run.status === "scheduled_retry" && run.scheduledRetryAt) {
      return `${run.agentName}: retry ${new Date(run.scheduledRetryAt).toLocaleTimeString()}`;
    }
    return `${run.agentName}: #${run.position} of ${data.queuedCount} · agent #${run.agentPosition} · ${compactDuration(run.position * run.medianDurationMs)}`;
  }

  async function refresh() {
    if (!document.body) return;
    const route = routeState();
    if (!route.prefix) return;
    try {
      const id = await resolveCompany(route.prefix);
      if (!id) return;
      const response = await fetch(`/api/companies/${id}/openrouter-queue`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`Queue lookup failed: HTTP ${response.status}`);
      const data = await response.json();
      const runs = Array.isArray(data.runs) ? data.runs : [];
      const relevant = runs.find(run =>
        (route.runId && run.id === route.runId) ||
        (route.issueIdentifier && run.issueIdentifier === route.issueIdentifier) ||
        (route.agent && run.agentId === route.agent && run.status === "running")
      );
      const element = badge();
      if (relevant) {
        element.textContent = `OpenRouter · ${statusText(relevant, data)}`;
      } else {
        element.textContent =
          `OpenRouter · ${data.queuedCount} queued · ${data.runningCount} running · ${data.workerCount} workers` +
          (data.quotaCooldownUntil ? ` · quota wait until ${new Date(data.quotaCooldownUntil).toLocaleTimeString()}` : "");
      }
      element.hidden = false;
    } catch {
      const element = badge();
      element.textContent = "OpenRouter queue unavailable";
      element.hidden = false;
    }
  }

  function schedule() {
    clearInterval(timer);
    companyId = "";
    void refresh();
    timer = setInterval(refresh, 15_000);
  }

  const historyPushState = history.pushState.bind(history);
  history.pushState = (...args) => {
    historyPushState(...args);
    schedule();
  };
  const historyReplaceState = history.replaceState.bind(history);
  history.replaceState = (...args) => {
    historyReplaceState(...args);
    schedule();
  };
  addEventListener("popstate", schedule);
  addEventListener("DOMContentLoaded", schedule, { once: true });
  if (document.readyState !== "loading") schedule();
})();
