let client;
const DASHBOARD_AUTO_RETRY_DELAY_MS = 1800;
const DASHBOARD_INVOKE_TIMEOUT_MS = 14000;
const DASHBOARD_STUCK_TIMEOUT_MS = 18000;
const DASHBOARD_CACHE_MAX_AGE_MS = 86400000;
const DASHBOARD_CACHE_KEY_PREFIX = "trello_connector_dashboard_cache_v1:";

const state = {
  loading: true,
  dashboardRequestId: 0,
  dashboardLoadInFlight: false,
  dashboardLoadQueued: false,
  dashboardQueuedSilent: true,
  dashboardLoaded: false,
  dashboardRetryTimer: null,
  dashboardWatchdogTimer: null,
  iparams: {},
  dashboard: {
    summary: {
      total_linked_tickets: 0,
      total_linked_tasks: 0,
    },
    insights: {
      sync_health: {
        healthy_tickets: 0,
        needs_attention_tickets: 0,
        stale_tickets: 0,
        stale_after_days: 14,
      },
      board_distribution: [],
      list_distribution: [],
      multi_card_tickets: {
        ticket_count: 0,
        top_tickets: [],
      },
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
  try {
    const iparams = await client.iparams.get();
    state.iparams = iparams && typeof iparams === "object" ? iparams : {};
  } catch (error) {
    console.error("Failed to load dashboard installation parameters:", error);
    state.iparams = {};
  }
  bindRefs();
  bindEvents();
  restoreCachedDashboard();
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
  refs.healthDonut = document.getElementById("healthDonut");
  refs.needsAttentionValue = document.getElementById("needsAttentionValue");
  refs.healthyTicketsValue = document.getElementById("healthyTicketsValue");
  refs.attentionTicketsValue = document.getElementById("attentionTicketsValue");
  refs.staleTicketsValue = document.getElementById("staleTicketsValue");
  refs.boardCountValue = document.getElementById("boardCountValue");
  refs.boardDistributionBars = document.getElementById("boardDistributionBars");
  refs.multiCardTicketsValue = document.getElementById("multiCardTicketsValue");
  refs.multiCardBars = document.getElementById("multiCardBars");
  refs.listDistributionBars = document.getElementById("listDistributionBars");
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
  startDashboardWatchdog({ requestId, silent, retryAttempt });

  if (!silent) {
    clearMessage();
  }
  render();

  try {
    const dashboard = await invokeWithTimeout("getDashboardData", {}, DASHBOARD_INVOKE_TIMEOUT_MS);

    if (requestId !== state.dashboardRequestId) {
      return;
    }

    if (!isUsableDashboardPayload(dashboard)) {
      throw new Error("Dashboard returned incomplete data.");
    }

    if (shouldKeepExistingDashboard(dashboard)) {
      restoreCachedDashboard();
      if (!silent) {
        showMessage("Dashboard returned an empty snapshot — cached values are still shown. Try again in a moment.", "info");
      }
      return;
    }

    state.dashboard = dashboard;
    state.dashboardLoaded = true;
    writeCachedDashboard(dashboard);
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
        scheduleDashboardRetry({ requestId, silent, retryAttempt: retryAttempt + 1 });
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

// ── Render ──────────────────────────────────────────────────────────────────

function render() {
  renderTopState();
  renderSummary();
  renderInsights();
  renderLinkedTickets();
  renderMessage();
}

function renderTopState() {
  refs.refreshBtn.disabled = state.loading;
  refs.refreshBtn.textContent = state.loading ? "Refreshing..." : "Refresh";
  refs.statusLine.textContent = state.loading ? "Loading dashboard data..." : "Dashboard is up to date.";
}

function renderSummary() {
  if (!state.dashboardLoaded) {
    refs.linkedTicketsValue.textContent = "-";
    refs.linkedTasksValue.textContent = "-";
    return;
  }

  const summary = state.dashboard && state.dashboard.summary ? state.dashboard.summary : {};
  refs.linkedTicketsValue.textContent = String(Number(summary.total_linked_tickets) || 0);
  refs.linkedTasksValue.textContent = String(Number(summary.total_linked_tasks) || 0);
}

function renderInsights() {
  if (!state.dashboardLoaded) {
    renderInsightLoading();
    return;
  }

  const insights = normalizeInsights(state.dashboard && state.dashboard.insights);
  renderSyncHealth(insights.sync_health);
  renderBoardDistribution(insights.board_distribution);
  renderMultiCardTickets(insights.multi_card_tickets);
  renderListDistribution(insights.list_distribution);
}

function renderInsightLoading() {
  refs.needsAttentionValue.textContent = "-";
  refs.healthyTicketsValue.textContent = "-";
  refs.attentionTicketsValue.textContent = "-";
  refs.staleTicketsValue.textContent = "-";
  refs.healthDonut.style.background = "#ecf0f5";
  refs.boardCountValue.textContent = "-";
  refs.boardDistributionBars.innerHTML = `<div class="chart-empty">Loading data...</div>`;
  refs.multiCardTicketsValue.textContent = "-";
  refs.multiCardBars.innerHTML = `<div class="chart-empty">Loading data...</div>`;
  refs.listDistributionBars.innerHTML = `<div class="chart-empty">Loading data...</div>`;
}

function renderSyncHealth(syncHealth) {
  const healthy = Number(syncHealth && syncHealth.healthy_tickets) || 0;
  const attention = Number(syncHealth && syncHealth.needs_attention_tickets) || 0;
  const stale = Number(syncHealth && syncHealth.stale_tickets) || 0;
  const total = Math.max(healthy + attention + stale, 1);
  const healthyStop = Math.round((healthy / total) * 100);
  const attentionStop = healthyStop + Math.round((attention / total) * 100);

  refs.needsAttentionValue.textContent = String(attention);
  refs.healthyTicketsValue.textContent = String(healthy);
  refs.attentionTicketsValue.textContent = String(attention);
  refs.staleTicketsValue.textContent = String(stale);
  refs.healthDonut.style.background = `conic-gradient(var(--success) 0 ${healthyStop}%, var(--danger) ${healthyStop}% ${attentionStop}%, #95a3b7 ${attentionStop}% 100%)`;
}

function renderBoardDistribution(boards) {
  const items = Array.isArray(boards) ? boards : [];
  refs.boardCountValue.textContent = String(items.length);

  if (!items.length) {
    refs.boardDistributionBars.innerHTML = `<div class="chart-empty">No board data yet</div>`;
    return;
  }

  const max = Math.max(...items.map((b) => Number(b.card_count) || 0), 1);
  refs.boardDistributionBars.innerHTML = items
    .map((b) => renderBarRow({
      label: truncateText(b.board || "-", 14),
      value: Number(b.card_count) || 0,
      width: ((Number(b.card_count) || 0) / max) * 100,
      fillClass: "",
    }))
    .join("");
}

function renderMultiCardTickets(multiCardTickets) {
  const count = Number(multiCardTickets && multiCardTickets.ticket_count) || 0;
  const topTickets = Array.isArray(multiCardTickets && multiCardTickets.top_tickets)
    ? multiCardTickets.top_tickets
    : [];

  refs.multiCardTicketsValue.textContent = String(count);

  if (!topTickets.length) {
    refs.multiCardBars.innerHTML = `<div class="chart-empty">No tickets with multiple cards</div>`;
    return;
  }

  const max = Math.max(...topTickets.map((t) => Number(t.task_count) || 0), 1);
  refs.multiCardBars.innerHTML = topTickets
    .map((t) => renderBarRow({
      label: `#${truncateText(String(t.ticket_id || "-"), 12)}`,
      value: Number(t.task_count) || 0,
      width: ((Number(t.task_count) || 0) / max) * 100,
      fillClass: "bar-fill-secondary",
    }))
    .join("");
}

function renderListDistribution(lists) {
  const items = Array.isArray(lists) ? lists : [];

  if (!items.length) {
    refs.listDistributionBars.innerHTML = `<div class="chart-empty">No list data yet</div>`;
    return;
  }

  const max = Math.max(...items.map((l) => Number(l.count) || 0), 1);
  refs.listDistributionBars.innerHTML = items
    .map((l) => renderBarRow({
      label: truncateText(l.list || "-", 14),
      value: Number(l.count) || 0,
      width: ((Number(l.count) || 0) / max) * 100,
      fillClass: "bar-fill-muted",
    }))
    .join("");
}

function renderBarRow(options) {
  return `
    <div class="bar-row">
      <div class="bar-label">${escapeHtml(options.label || "-")}</div>
      <div class="bar-track">
        <span class="bar-fill ${escapeAttribute(options.fillClass || "")}" style="width: ${escapeAttribute(String(options.width || 0))}%;"></span>
      </div>
      <div class="bar-value">${escapeHtml(String(options.value || 0))}</div>
    </div>
  `;
}

function renderLinkedTickets() {
  if (!state.dashboardLoaded) {
    refs.emptyState.classList.add("hidden");
    refs.recentTable.classList.add("hidden");
    refs.recentTableBody.innerHTML = "";
    return;
  }

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
      const ticketId = String(ticket.ticket_id || "").trim();
      const ticketUrl = buildFreshdeskTicketUrl(ticketId);
      const location = [ticket.workspace_name, ticket.list_name].filter(Boolean).join(" / ") || "-";
      const syncBadge = ticket.has_sync_error
        ? `<span class="badge badge-danger">Needs attention</span>`
        : `<span class="badge badge-success">Healthy</span>`;
      return `
        <tr>
          <td>
            ${ticketUrl
              ? `<a class="table-link" href="${escapeAttribute(ticketUrl)}" target="_blank" rel="noreferrer">#${escapeHtml(ticketId)}</a>`
              : `#${escapeHtml(ticketId || "-")}`}
          </td>
          <td>${escapeHtml(String(ticket.task_count || 0))}</td>
          <td>
            ${ticket.latest_task_url
              ? `<a class="table-link" href="${escapeAttribute(ticket.latest_task_url)}" target="_blank" rel="noreferrer">${escapeHtml(ticket.latest_task_name || "Open card")}</a>`
              : escapeHtml(ticket.latest_task_name || "-")}
          </td>
          <td>${escapeHtml(location)}</td>
          <td>${syncBadge}</td>
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

// ── Cache ────────────────────────────────────────────────────────────────────

function getDashboardCacheKey() {
  const domain = normalizeFreshdeskDomain(state.iparams && state.iparams.domain) || "default";
  return `${DASHBOARD_CACHE_KEY_PREFIX}${domain}`;
}

function restoreCachedDashboard() {
  const cachedDashboard = readCachedDashboard();
  if (!cachedDashboard || !hasDashboardActivity(cachedDashboard)) {
    return false;
  }
  state.dashboard = cachedDashboard;
  state.dashboardLoaded = true;
  return true;
}

function readCachedDashboard() {
  try {
    const raw = window.localStorage.getItem(getDashboardCacheKey());
    if (!raw) {
      return null;
    }
    const cached = JSON.parse(raw);
    const dashboard = cached && cached.dashboard;
    if (!isFreshDashboardCache(cached) || !isUsableDashboardPayload(dashboard)) {
      return null;
    }
    return dashboard;
  } catch (error) {
    console.warn("Unable to read cached dashboard data:", error);
    return null;
  }
}

function isFreshDashboardCache(cached) {
  const cachedAt = Number(cached && cached.cached_at) || 0;
  return cachedAt > 0 && Date.now() - cachedAt <= DASHBOARD_CACHE_MAX_AGE_MS;
}

function writeCachedDashboard(dashboard) {
  if (!isUsableDashboardPayload(dashboard) || !hasDashboardActivity(dashboard)) {
    return;
  }
  try {
    window.localStorage.setItem(getDashboardCacheKey(), JSON.stringify({
      cached_at: Date.now(),
      dashboard,
    }));
  } catch (error) {
    console.warn("Unable to cache dashboard data:", error);
  }
}

function isUsableDashboardPayload(dashboard) {
  return Boolean(
    dashboard &&
      typeof dashboard === "object" &&
      dashboard.summary &&
      typeof dashboard.summary === "object" &&
      dashboard.insights &&
      typeof dashboard.insights === "object" &&
      Array.isArray(dashboard.linked_tickets)
  );
}

function shouldKeepExistingDashboard(nextDashboard) {
  return hasDashboardActivity(state.dashboard) && !hasDashboardActivity(nextDashboard);
}

function hasDashboardActivity(dashboard) {
  const summary = dashboard && dashboard.summary ? dashboard.summary : {};
  const linkedTickets = Array.isArray(dashboard && dashboard.linked_tickets)
    ? dashboard.linked_tickets
    : [];
  return (
    linkedTickets.length > 0 ||
    Number(summary.total_linked_tickets) > 0 ||
    Number(summary.total_linked_tasks) > 0
  );
}

// ── Normalize ────────────────────────────────────────────────────────────────

function normalizeInsights(value) {
  const insights = value && typeof value === "object" ? value : {};
  return {
    sync_health: insights.sync_health && typeof insights.sync_health === "object"
      ? insights.sync_health
      : { healthy_tickets: 0, needs_attention_tickets: 0, stale_tickets: 0, stale_after_days: 14 },
    board_distribution: Array.isArray(insights.board_distribution) ? insights.board_distribution : [],
    list_distribution: Array.isArray(insights.list_distribution) ? insights.list_distribution : [],
    multi_card_tickets: insights.multi_card_tickets && typeof insights.multi_card_tickets === "object"
      ? insights.multi_card_tickets
      : { ticket_count: 0, top_tickets: [] },
  };
}

// ── Server invoke ────────────────────────────────────────────────────────────

async function invokeServerFunction(name, body) {
  const result = await client.request.invoke(name, { body });
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

// ── Message helpers ──────────────────────────────────────────────────────────

function showMessage(text, type) {
  state.message = { text, type };
}

function clearMessage() {
  state.message = { text: "", type: "" };
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

// ── URL helpers ──────────────────────────────────────────────────────────────

function buildFreshdeskTicketUrl(ticketId) {
  const id = String(ticketId || "").trim();
  const domain = normalizeFreshdeskDomain(state.iparams && state.iparams.domain);
  if (!id || !domain) {
    return "";
  }
  return `https://${domain}/a/tickets/${encodeURIComponent(id)}`;
}

function normalizeFreshdeskDomain(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  if (!cleaned) {
    return "";
  }
  return cleaned.includes(".") ? cleaned : `${cleaned}.freshdesk.com`;
}

// ── Formatters ───────────────────────────────────────────────────────────────

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

function truncateText(value, maxLength) {
  const text = String(value || "");
  const limit = Number(maxLength) || 12;
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 1))}.`;
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
