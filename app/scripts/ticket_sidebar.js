let client;

const state = {
  loaded: false,
  loading: false,
  ticket: null,
  iparams: null,
  linkedTasks: [],
  busyAction: "",
  openMenuTaskId: "",
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
    state.iparams = await client.iparams.get();
  } catch (error) {
    console.error("Failed to load iparams for Trello sidebar:", error);
    state.iparams = {};
  }
  bindRefs();
  bindEvents();
  render();

  client.events.on("app.activated", () => {
    void loadSidebar({ force: !state.loaded });
  });

  client.instance.receive((event) => {
    const raw = event && event.helper ? event.helper.getData() : null;
    const payload = raw && raw.message ? raw.message : raw;
    handleInstanceMessage(payload);
  });
}

function bindRefs() {
  refs.ticketSummary = document.getElementById("ticketSummary");
  refs.taskCountBadge = document.getElementById("taskCountBadge");
  refs.createTaskBtn = document.getElementById("createTaskBtn");
  refs.linkTaskBtn = document.getElementById("linkTaskBtn");
  refs.syncNowBtn = document.getElementById("syncNowBtn");
  refs.refreshBtn = document.getElementById("refreshBtn");
  refs.pageMessage = document.getElementById("pageMessage");
  refs.listState = document.getElementById("listState");
  refs.taskList = document.getElementById("taskList");
  refs.helperCopy = document.getElementById("helperCopy");
}

function bindEvents() {
  refs.createTaskBtn.addEventListener("click", () => {
    void openTaskModal("create");
  });
  refs.linkTaskBtn.addEventListener("click", () => {
    void openTaskModal("link");
  });
  refs.syncNowBtn.addEventListener("click", () => {
    void syncLinkedTasks();
  });
  refs.refreshBtn.addEventListener("click", () => {
    void loadSidebar({ force: true });
  });

  refs.taskList.addEventListener("click", (event) => {
    const menuToggle = event.target.closest("[data-action='toggle-menu']");
    if (menuToggle) {
      event.preventDefault();
      toggleTaskMenu(menuToggle.getAttribute("data-task-id"));
      return;
    }

    const unlinkButton = event.target.closest("[data-action='unlink']");
    if (!unlinkButton) {
      return;
    }

    event.preventDefault();
    void unlinkTask(unlinkButton.getAttribute("data-task-id"));
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".task-actions")) {
      closeTaskMenu();
    }
  });
}

async function loadSidebar(options) {
  const force = Boolean(options && options.force);
  if (state.loading) {
    return;
  }
  if (state.loaded && !force) {
    render();
    return;
  }

  state.loading = true;
  state.busyAction = force && state.loaded ? "refresh" : "";
  state.openMenuTaskId = "";
  if (!state.loaded) {
    clearPageMessage();
  }
  render();

  try {
    const ticketData = await client.data.get("ticket");
    state.ticket = normalizeTicket(ticketData);

    const payload = await loadSidebarDataWithRetry();
    state.linkedTasks = Array.isArray(payload.linked_tasks) ? payload.linked_tasks : [];
    state.loaded = true;
  } catch (error) {
    console.error("Failed to load Trello sidebar data:", error);
    state.loaded = true;
    showPageMessage(resolveSidebarError(error), "error");
  } finally {
    state.loading = false;
    state.busyAction = "";
    render();
  }
}

async function loadSidebarDataWithRetry() {
  try {
    return await invokeServerFunction("getSidebarData", {
      ticket_id: state.ticket && state.ticket.id,
    });
  } catch (error) {
    if (!isTimeoutError(error)) {
      throw error;
    }

    await delay(700);
    return await invokeServerFunction("getSidebarData", {
      ticket_id: state.ticket && state.ticket.id,
    });
  }
}

function normalizeTicket(payload) {
  const ticket = payload && payload.ticket ? payload.ticket : payload;
  return {
    id: normalizeText(ticket && ticket.id),
    subject: normalizeText(ticket && ticket.subject),
    descriptionText: normalizeText(ticket && (ticket.description_text || stripHtml(ticket.description))),
    priority: normalizeText(ticket && ticket.priority),
    status: normalizeText(ticket && ticket.status),
    customFields: normalizeCustomFields(ticket && (ticket.custom_fields || ticket.customFields)),
  };
}

function normalizeCustomFields(value) {
  if (!value || typeof value !== "object") {
    return {};
  }
  return value;
}

function render() {
  renderSummary();
  renderActions();
  renderMessage();
  renderTaskCount();
  renderTaskList();
  renderHelperCopy();
}

function renderSummary() {
  if (!state.loaded && !state.loading) {
    refs.ticketSummary.textContent = "Open the app to load linked Trello cards for this ticket.";
    return;
  }

  if (state.loading && !state.ticket) {
    refs.ticketSummary.textContent = "Loading Trello details for this ticket...";
    return;
  }

  if (!state.ticket || !state.ticket.id) {
    refs.ticketSummary.textContent = "Freshdesk ticket details are not available in this view.";
    return;
  }

  refs.ticketSummary.textContent = `Ticket #${state.ticket.id}${state.ticket.subject ? `: ${state.ticket.subject}` : ""}`;
}

function renderActions() {
  const missingTicket = !state.ticket || !state.ticket.id;
  const disableBase = state.loading || state.busyAction === "sync" || state.busyAction.startsWith("unlink:");
  refs.createTaskBtn.disabled = missingTicket || disableBase;
  refs.linkTaskBtn.disabled = missingTicket || disableBase;
  refs.refreshBtn.disabled = state.loading || state.busyAction === "sync";
  refs.syncNowBtn.disabled = missingTicket || !state.linkedTasks.length || disableBase;
  refs.syncNowBtn.classList.toggle("hidden", !state.linkedTasks.length);

  refs.refreshBtn.textContent = state.busyAction === "refresh" ? "Refreshing..." : "Refresh";
  refs.syncNowBtn.textContent = state.busyAction === "sync" ? "Syncing..." : "Sync Now";
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

function renderTaskCount() {
  refs.taskCountBadge.textContent = String(state.linkedTasks.length || 0);
}

function renderTaskList() {
  if (!state.loaded && !state.loading) {
    refs.listState.classList.remove("hidden");
    refs.listState.textContent = "Open the app to check whether this ticket already has linked Trello cards.";
    refs.taskList.classList.add("hidden");
    refs.taskList.innerHTML = "";
    return;
  }

  if (state.loading && !state.linkedTasks.length) {
    refs.listState.classList.remove("hidden");
    refs.listState.textContent = "Loading linked Trello cards...";
    refs.taskList.classList.add("hidden");
    refs.taskList.innerHTML = "";
    return;
  }

  if (!state.linkedTasks.length) {
    refs.listState.classList.remove("hidden");
    refs.listState.textContent = "No Trello cards are linked yet. Create a new card or link an existing one when you are ready.";
    refs.taskList.classList.add("hidden");
    refs.taskList.innerHTML = "";
    return;
  }

  refs.listState.classList.add("hidden");
  refs.taskList.classList.remove("hidden");
  refs.taskList.innerHTML = state.linkedTasks
    .map((task) => {
      const location = [task.workspace_name, task.space_name, task.list_name].filter(Boolean).join(" / ");
      const labels = normalizeLabels(task.labels || task.priority_label);
      const meta = [
        task.status,
        task.due_date ? `Due ${formatDate(task.due_date)}` : "",
        formatAssigneeLabel(task.assignees),
      ].filter(Boolean);
      const unlinking = state.busyAction === `unlink:${task.task_id}`;
      const menuOpen = state.openMenuTaskId === task.task_id;
      return `
        <article class="task-card">
          <div class="task-head">
            <div>
              <a class="task-link" href="${escapeAttribute(task.task_url)}" target="_blank" rel="noreferrer">
                ${escapeHtml(task.task_name)}
              </a>
              ${location ? `<div class="task-location">${escapeHtml(location)}</div>` : ""}
            </div>
            <div class="task-actions">
              <button
                class="icon-btn"
                type="button"
                aria-label="Task actions"
                data-action="toggle-menu"
                data-task-id="${escapeAttribute(task.task_id)}"
                ${unlinking || state.loading || state.busyAction === "sync" ? "disabled" : ""}
              >
                ...
              </button>
              <div class="menu${menuOpen ? "" : " hidden"}">
                <button
                  class="menu-item"
                  type="button"
                  data-action="unlink"
                  data-task-id="${escapeAttribute(task.task_id)}"
                  ${unlinking || state.loading || state.busyAction === "sync" ? "disabled" : ""}
                >
                  ${unlinking ? "Unlinking..." : "Unlink task"}
                </button>
              </div>
            </div>
          </div>
          ${labels.length ? `<div class="label-row">${labels.map(renderLabelChip).join("")}</div>` : ""}
          ${meta.length ? `<div class="meta">${meta.map((item) => `<span class="pill">${escapeHtml(item)}</span>`).join("")}</div>` : ""}
          ${task.last_sync_error ? `<div class="sync-error">${escapeHtml(task.last_sync_error)}</div>` : ""}
        </article>
      `;
    })
    .join("");
}

function renderHelperCopy() {
  if (!state.linkedTasks.length) {
    refs.helperCopy.textContent = "Use Create Card or Link Card to connect this ticket with Trello.";
    return;
  }

  refs.helperCopy.textContent = "Use Sync Now whenever you want the latest Freshdesk title and description pushed to every linked Trello card.";
}

async function openTaskModal(mode) {
  if (!state.ticket || !state.ticket.id) {
    showPageMessage("Ticket details are not available yet. Refresh and try again.", "error");
    return;
  }

  clearPageMessage();
  closeTaskMenu();

  try {
    await client.interface.trigger("showModal", {
      title: mode === "create" ? "Create Trello Card" : "Link Trello Card",
      template: "index.html",
      data: {
        mode,
        ticket: state.ticket,
        linked_task_ids: state.linkedTasks.map((task) => task.task_id),
      },
    });
  } catch (error) {
    console.error("Failed to open Trello modal:", error);
    showPageMessage(resolveErrorMessage(error, "Unable to open the Trello window."), "error");
    render();
  }
}

async function syncLinkedTasks() {
  if (!state.ticket || !state.ticket.id || !state.linkedTasks.length) {
    return;
  }

  state.busyAction = "sync";
  closeTaskMenu();
  showPageMessage("Syncing linked Trello cards...", "info");
  render();

  try {
    const ticketData = await client.data.get("ticket");
    state.ticket = normalizeTicket(ticketData);

    const payload = await invokeServerFunction("syncLinkedTicketCards", {
      ticket_id: state.ticket.id,
      ticket: {
        id: state.ticket.id,
        subject: state.ticket.subject,
        description_text: state.ticket.descriptionText,
      },
      trello_api_key: getTrelloApiKey(),
    });

    state.linkedTasks = Array.isArray(payload.linked_tasks) ? payload.linked_tasks : state.linkedTasks;
    showPageMessage("Linked Trello cards synced successfully.", "success");
  } catch (error) {
    console.error("Failed to sync linked Trello cards:", error);
    showPageMessage(resolveErrorMessage(error, "Unable to sync linked Trello cards."), "error");
  } finally {
    state.busyAction = "";
    render();
  }
}

async function unlinkTask(taskId) {
  if (!state.ticket || !state.ticket.id || !taskId) {
    return;
  }

  state.busyAction = `unlink:${taskId}`;
  closeTaskMenu();
  clearPageMessage();
  render();

  try {
    const payload = await invokeServerFunction("unlinkTicketCard", {
      ticket_id: state.ticket.id,
      task_id: taskId,
      trello_api_key: getTrelloApiKey(),
    });

    state.linkedTasks = Array.isArray(payload.linked_tasks) ? payload.linked_tasks : [];
    state.openMenuTaskId = "";
    showPageMessage("Card unlinked successfully.", "success");
  } catch (error) {
    console.error("Failed to unlink Trello card:", error);
    showPageMessage(resolveErrorMessage(error, "Unable to unlink the Trello card."), "error");
  } finally {
    state.busyAction = "";
    render();
  }
}

function handleInstanceMessage(data) {
  if (!data || typeof data !== "object") {
    return;
  }

  if (Array.isArray(data.linked_tasks)) {
    state.linkedTasks = data.linked_tasks;
    state.loaded = true;
    state.openMenuTaskId = "";
  }

  if (data.notice) {
    showPageMessage(data.notice, "success");
  }

  render();
}

function getTrelloApiKey() {
  return normalizeText(state.iparams && state.iparams.trello_api_key);
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

function showPageMessage(text, type) {
  state.message = {
    text,
    type,
  };
}

function clearPageMessage() {
  state.message = {
    text: "",
    type: "",
  };
}

function toggleTaskMenu(taskId) {
  const normalized = normalizeText(taskId);
  state.openMenuTaskId = state.openMenuTaskId === normalized ? "" : normalized;
  render();
}

function closeTaskMenu() {
  if (!state.openMenuTaskId) {
    return;
  }

  state.openMenuTaskId = "";
  render();
}

function resolveSidebarError(error) {
  if (isTimeoutError(error)) {
    return "Loading the sidebar took too long. Please click Refresh and try again.";
  }

  return resolveErrorMessage(error, "Unable to load linked Trello cards.");
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

function isTimeoutError(error) {
  const message = resolveErrorMessage(error, "").toLowerCase();
  return message.includes("timed out");
}

function normalizeText(value) {
  return String(value || "").trim();
}

function stripHtml(value) {
  return normalizeText(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function formatDate(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }

  try {
    return new Date(normalized).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return normalized;
  }
}

function formatAssigneeLabel(assignees) {
  const people = Array.isArray(assignees) ? assignees.filter(Boolean) : [];
  if (!people.length) {
    return "";
  }

  const names = people
    .map((person) => normalizeText(person && person.name))
    .filter(Boolean);

  if (!names.length) {
    return "";
  }

  if (names.length === 1) {
    return names[0];
  }

  return `${names[0]} +${names.length - 1}`;
}

function normalizeLabels(value) {
  if (Array.isArray(value)) {
    return value
      .map((label) => normalizeLabelObject(label))
      .filter(Boolean);
  }

  const text = normalizeText(value);
  if (!text) {
    return [];
  }

  return text
    .split(",")
    .map((item) => normalizeLabelObject({ name: item.trim() }))
    .filter(Boolean);
}

function normalizeLabelObject(label) {
  const name = normalizeText(label && (label.name || label.label || label.title));
  const color = normalizeText(label && label.color).toLowerCase();

  if (!name && !color) {
    return null;
  }

  return {
    name: name || getTrelloColorLabel(color),
    color,
  };
}

function renderLabelChip(label) {
  const textColor = getTrelloColorHex(label.color);
  const background = getTrelloColorTint(label.color);

  return `
    <span class="label-chip" style="background:${escapeAttribute(background)}; color:${escapeAttribute(textColor)};">
      <span class="label-chip-dot"></span>
      ${escapeHtml(label.name)}
    </span>
  `;
}

function getTrelloColorHex(color) {
  const palette = {
    green: "#2f7d32",
    yellow: "#8a6d00",
    orange: "#b75a00",
    red: "#b42318",
    purple: "#7a3db8",
    blue: "#005fa3",
    sky: "#007b8f",
    lime: "#1b7f56",
    pink: "#b23b79",
    black: "#344563",
  };

  return palette[normalizeText(color).toLowerCase()] || "#39556f";
}

function getTrelloColorTint(color) {
  const palette = {
    green: "#e9f7e7",
    yellow: "#fff6d9",
    orange: "#fff0df",
    red: "#fdeceb",
    purple: "#f4ebff",
    blue: "#e7f1fb",
    sky: "#e6f8fb",
    lime: "#e8fbf1",
    pink: "#fdebf4",
    black: "#ebedf0",
  };

  return palette[normalizeText(color).toLowerCase()] || "#eaf0f7";
}

function getTrelloColorLabel(color) {
  const normalized = normalizeText(color);
  if (!normalized) {
    return "Trello label";
  }

  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)} label`;
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

function delay(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
