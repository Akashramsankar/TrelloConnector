let client;
const DASHBOARD_AUTO_RETRY_DELAY_MS = 1800;
const DASHBOARD_INVOKE_TIMEOUT_MS = 8000;
const DASHBOARD_STUCK_TIMEOUT_MS = 12000;

const state = {
  loading: true,
  dashboardRequestId: 0,
  dashboardLoadInFlight: false,
  dashboardLoadQueued: false,
  dashboardQueuedSilent: true,
  dashboardRetryTimer: null,
  dashboardWatchdogTimer: null,
  dashboard: {
    summary: {
      total_linked_tickets: 0,
      total_linked_tasks: 0,
    },
    linked_tickets: [],
  },
  message: {
    text: "",
    type: "",
  },
};

const refs = {};

document.addEventListener("DOMContentLoaded", () => {
  void initialize();
});

async function initialize() {
  client = await app.initialized();
  bindRefs();
  bindEvents();
  render();

  client.events.on("app.activated", () => {
    void loadDashboard({ silent: true });
  });

  await loadDashboard();
}

function bindRefs() {
  refs.refreshBtn = document.getElementById("refreshBtn");
  refs.statusLine = document.getElementById("statusLine");
  refs.pageMessage = document.getElementById("pageMessage");
  refs.linkedTicketsValue = document.getElementById("linkedTicketsValue");
  refs.linkedTasksValue = document.getElementById("linkedTasksValue");
  refs.emptyState = document.getElementById("emptyState");
  refs.recentTable = document.getElementById("recentTable");
  refs.recentTableBody = document.getElementById("recentTableBody");
}

function bindEvents() {
  refs.refreshBtn.addEventListener("click", () => {
    void loadDashboard();
  });
}

async function loadDashboard(options) {
  const silent = Boolean(options && options.silent);
  const retryAttempt = Number((options && options.retryAttempt) || 0);
  const isAutoRetry = Boolean(options && options.isAutoRetry);

  if (!isAutoRetry) {
    clearDashboardRetry();
  }

  if (state.dashboardLoadInFlight) {
    state.dashboardLoadQueued = true;
    state.dashboardQueuedSilent = state.dashboardQueuedSilent && silent;

    if (!silent) {
      state.loading = true;
      render();
    }
    return;
  }

  state.dashboardLoadInFlight = true;
  let nextSilent = silent;

  try {
    do {
      state.dashboardLoadQueued = false;
      state.dashboardQueuedSilent = true;
      await performDashboardLoad({ silent: nextSilent, retryAttempt });
      nextSilent = state.dashboardQueuedSilent;
    } while (state.dashboardLoadQueued);
  } finally {
    state.dashboardLoadInFlight = false;
  }
}

async function performDashboardLoad(options) {
  const silent = Boolean(options && options.silent);
  const retryAttempt = Number((options && options.retryAttempt) || 0);
  const requestId = state.dashboardRequestId + 1;
  let shouldRetry = false;
  state.dashboardRequestId = requestId;
  state.loading = true;
  startDashboardWatchdog({
    requestId,
    silent,
    retryAttempt,
  });

  if (!silent) {
    clearMessage();
  }
  render();

  try {
    const dashboard = await invokeWithTimeout("getDashboardData", {}, DASHBOARD_INVOKE_TIMEOUT_MS);

    if (requestId !== state.dashboardRequestId) {
      return;
    }

    state.dashboard = dashboard || {
      summary: {
        total_linked_tickets: 0,
        total_linked_tasks: 0,
      },
      linked_tickets: [],
    };
  } catch (error) {
    if (requestId !== state.dashboardRequestId) {
      return;
    }

    console.error("Failed to load Trello connector dashboard:", error);
    shouldRetry = retryAttempt < 1;

    if (!shouldRetry) {
      showMessage(resolveDashboardError(error), "error");
    }
  } finally {
    if (requestId === state.dashboardRequestId) {
      clearDashboardWatchdog();
      state.loading = false;
      render();

      if (shouldRetry && !state.dashboardLoadQueued) {
        scheduleDashboardRetry({
          requestId,
          silent,
          retryAttempt: retryAttempt + 1,
        });
      }
    }
  }
}

function scheduleDashboardRetry(options) {
  const requestId = Number(options && options.requestId);
  if (!requestId || requestId !== state.dashboardRequestId) {
    return;
  }

  clearDashboardRetry();
  state.dashboardRetryTimer = window.setTimeout(() => {
    state.dashboardRetryTimer = null;
    if (requestId !== state.dashboardRequestId) {
      return;
    }

    void loadDashboard({
      silent: Boolean(options && options.silent),
      retryAttempt: Number((options && options.retryAttempt) || 1),
      isAutoRetry: true,
    });
  }, DASHBOARD_AUTO_RETRY_DELAY_MS);
}

function clearDashboardRetry() {
  if (state.dashboardRetryTimer) {
    window.clearTimeout(state.dashboardRetryTimer);
    state.dashboardRetryTimer = null;
  }
}

function startDashboardWatchdog(options) {
  clearDashboardWatchdog();
  const requestId = Number(options && options.requestId);

  state.dashboardWatchdogTimer = window.setTimeout(() => {
    state.dashboardWatchdogTimer = null;

    if (!requestId || requestId !== state.dashboardRequestId || !state.loading) {
      return;
    }

    const retryAttempt = Number((options && options.retryAttempt) || 0);
    const shouldRetry = retryAttempt < 1;

    state.loading = false;
    state.dashboardLoadInFlight = false;
    state.dashboardLoadQueued = false;

    if (!shouldRetry) {
      showMessage("Dashboard refresh got stuck. Please try again.", "error");
    }
    render();

    if (shouldRetry) {
      void loadDashboard({
        silent: Boolean(options && options.silent),
        retryAttempt: retryAttempt + 1,
        isAutoRetry: true,
      });
    }
  }, DASHBOARD_STUCK_TIMEOUT_MS);
}

function clearDashboardWatchdog() {
  if (state.dashboardWatchdogTimer) {
    window.clearTimeout(state.dashboardWatchdogTimer);
    state.dashboardWatchdogTimer = null;
  }
}

async function invokeWithTimeout(name, body, timeoutMs) {
  let timeoutId = null;

  try {
    return await Promise.race([
      invokeServerFunction(name, body),
      new Promise((_, reject) => {
        timeoutId = window.setTimeout(() => {
          reject(new Error("Request timed out!"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      window.clearTimeout(timeoutId);
    }
  }
}

function resolveDashboardError(error) {
  const message = resolveErrorMessage(error, "Unable to load dashboard data.");
  if (message.toLowerCase().includes("timed out")) {
    return "Loading the dashboard took too long. Retrying once automatically.";
  }
  return message;
}

function render() {
  renderTopState();
  renderSummary();
  renderLinkedTickets();
  renderMessage();
}

function renderTopState() {
  refs.refreshBtn.disabled = state.loading;
  refs.refreshBtn.textContent = state.loading ? "Refreshing..." : "Refresh";
  refs.statusLine.textContent = state.loading ? "Loading dashboard data..." : "Dashboard is up to date.";
}

function renderSummary() {
  const summary = state.dashboard && state.dashboard.summary ? state.dashboard.summary : {};
  refs.linkedTicketsValue.textContent = String(Number(summary.total_linked_tickets) || 0);
  refs.linkedTasksValue.textContent = String(Number(summary.total_linked_tasks) || 0);
}

function renderLinkedTickets() {
  const linkedTickets = Array.isArray(state.dashboard && state.dashboard.linked_tickets)
    ? state.dashboard.linked_tickets
    : [];

  if (!linkedTickets.length) {
    refs.emptyState.classList.remove("hidden");
    refs.recentTable.classList.add("hidden");
    refs.recentTableBody.innerHTML = "";
    return;
  }

  refs.emptyState.classList.add("hidden");
  refs.recentTable.classList.remove("hidden");
  refs.recentTableBody.innerHTML = linkedTickets
    .map((ticket) => {
      const location = [ticket.workspace_name, ticket.space_name, ticket.list_name].filter(Boolean).join(" / ") || "-";
      const syncState = ticket.has_sync_error ? "Needs attention" : "Healthy";
      return `
        <tr>
          <td>#${escapeHtml(ticket.ticket_id || "-")}</td>
          <td>${escapeHtml(String(ticket.task_count || 0))}</td>
          <td>
            ${ticket.latest_task_url
              ? `<a class="table-link" href="${escapeAttribute(ticket.latest_task_url)}" target="_blank" rel="noreferrer">${escapeHtml(ticket.latest_task_name || "Open task")}</a>`
              : escapeHtml(ticket.latest_task_name || "-")}
          </td>
          <td>${escapeHtml(location)}</td>
          <td>${escapeHtml(syncState)}</td>
          <td>${escapeHtml(formatDateTime(ticket.last_activity_at))}</td>
        </tr>
      `;
    })
    .join("");
}

function renderMessage() {
  if (!state.message.text) {
    refs.pageMessage.textContent = "";
    refs.pageMessage.className = "message";
    return;
  }

  refs.pageMessage.textContent = state.message.text;
  refs.pageMessage.className = `message ${state.message.type || "info"}`;
}

async function invokeServerFunction(name, body) {
  const result = await client.request.invoke(name, {
    body,
  });
  const payload = parseInvokeResponse(result);

  if (!payload || payload.success === false) {
    throw new Error(resolveInvokeError(payload) || "Request failed.");
  }

  return payload;
}

function parseInvokeResponse(result) {
  if (!result) {
    return null;
  }
  if (typeof result === "string") {
    try {
      return JSON.parse(result);
    } catch {
      return null;
    }
  }
  if (typeof result.response === "string") {
    try {
      return JSON.parse(result.response);
    } catch {
      return null;
    }
  }
  if (result.response && typeof result.response === "object") {
    return result.response;
  }
  return typeof result === "object" ? result : null;
}

function resolveInvokeError(payload) {
  if (!payload) {
    return "";
  }

  return payload.message || payload.detail || "";
}

function showMessage(text, type) {
  state.message = {
    text,
    type,
  };
}

function clearMessage() {
  state.message = {
    text: "",
    type: "",
  };
}

function resolveErrorMessage(error, fallback) {
  if (error && error.message) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return fallback;
}

function formatDateTime(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "-";
  }

  try {
    return new Date(normalized).toLocaleString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return normalized;
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}
