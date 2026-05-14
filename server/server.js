const LINK_KEY_PREFIX = "clickup_ticket_links_v1:";
const TASK_LINK_KEY_PREFIX = "clickup_task_links_v1:";
const DASHBOARD_SUMMARY_KEY = "clickup_dashboard_summary_v1";
const DASHBOARD_RECENT_KEY = "clickup_dashboard_recent_v1";
const DASHBOARD_TICKETS_KEY = "clickup_dashboard_tickets_v1";
const TRELLO_WEBHOOK_STORE_KEY = "trello_webhooks_v1";
const TRELLO_RUNTIME_SETTINGS_KEY = "trello_runtime_settings_v1";
const TICKET_SUPPRESS_PREFIX = "clickup_ticket_suppress_v1:";
const TRELLO_CARD_SUPPRESS_PREFIX = "trello_card_suppress_v1:";
const TRELLO_APP_KEY = "81c7dea8b018a4a14f3275147eabd758";
const CLICKUP_PAGE_SIZE = 100;
const DASHBOARD_RECENT_LIMIT = 25;
const SYNC_SUPPRESS_WINDOW_MS = 45000;
const CLICKUP_COMMENT_REVERSE_EVENTS = new Set([
  "taskCommentPosted",
  "taskCommentUpdated",
  "taskUpdated",
]);
const CLICKUP_PRIORITY_LABELS = {
  "1": "Urgent",
  "2": "High",
  "3": "Normal",
  "4": "Low",
};
const FRESHDESK_TO_CLICKUP_PRIORITY = {
  "1": 4,
  "2": 3,
  "3": 2,
  "4": 1,
};

function parseArgs(args) {
  if (!args) {
    return {};
  }

  if (typeof args.body === "string") {
    return safeParseJson(args.body, {});
  }

  if (args.body && typeof args.body === "object") {
    return args.body;
  }

  return args;
}

function safeParseJson(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (typeof value === "object") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeText(value) {
  return String(value || "").trim();
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stripHtml(value) {
  return normalizeText(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function buildDbKey(ticketId) {
  return `${LINK_KEY_PREFIX}${normalizeText(ticketId)}`;
}

function buildTaskLinkKey(taskId) {
  return `${TASK_LINK_KEY_PREFIX}${normalizeText(taskId)}`;
}

function buildSuppressionKey(prefix, recordId) {
  return `${prefix}${normalizeText(recordId)}`;
}

async function readTicketLinks(ticketId) {
  const key = buildDbKey(ticketId);

  try {
    const stored = await $db.get(key);
    return {
      ticket_id: normalizeText(ticketId),
      tasks: Array.isArray(stored && stored.tasks) ? stored.tasks : [],
    };
  } catch (error) {
    if (error && error.status === 404) {
      return {
        ticket_id: normalizeText(ticketId),
        tasks: [],
      };
    }
    throw error;
  }
}

async function readTaskLinks(taskId) {
  const key = buildTaskLinkKey(taskId);

  try {
    const stored = await $db.get(key);
    return {
      task_id: normalizeText(taskId),
      ticket_ids: Array.isArray(stored && stored.ticket_ids) ? stored.ticket_ids.map(normalizeText).filter(Boolean) : [],
    };
  } catch (error) {
    if (error && error.status === 404) {
      return {
        task_id: normalizeText(taskId),
        ticket_ids: [],
      };
    }
    throw error;
  }
}

async function writeTaskLinks(taskId, ticketIds) {
  const normalizedTaskId = normalizeText(taskId);
  const uniqueTicketIds = Array.from(new Set((Array.isArray(ticketIds) ? ticketIds : []).map(normalizeText).filter(Boolean)));

  if (!uniqueTicketIds.length) {
    try {
      await $db.delete(buildTaskLinkKey(normalizedTaskId));
    } catch (error) {
      if (!(error && error.status === 404)) {
        throw error;
      }
    }
    return;
  }

  await $db.set(buildTaskLinkKey(normalizedTaskId), {
    task_id: normalizedTaskId,
    ticket_ids: uniqueTicketIds,
  });
}

async function syncReverseTaskLinks(ticketId, previousTasks, nextTasks) {
  const normalizedTicketId = normalizeText(ticketId);
  const previousIds = new Set((Array.isArray(previousTasks) ? previousTasks : []).map((task) => normalizeText(task && task.task_id)).filter(Boolean));
  const nextIds = new Set((Array.isArray(nextTasks) ? nextTasks : []).map((task) => normalizeText(task && task.task_id)).filter(Boolean));
  const changedTaskIds = Array.from(new Set([...previousIds, ...nextIds])).filter(Boolean);

  for (let index = 0; index < changedTaskIds.length; index += 1) {
    const taskId = changedTaskIds[index];
    const stored = await readTaskLinks(taskId);
    let ticketIds = stored.ticket_ids.filter((storedTicketId) => storedTicketId !== normalizedTicketId);

    if (nextIds.has(taskId)) {
      ticketIds.push(normalizedTicketId);
    }

    await writeTaskLinks(taskId, ticketIds);
  }
}

async function writeTicketLinks(ticketId, tasks) {
  const normalizedTicketId = normalizeText(ticketId);
  const previous = await readTicketLinks(normalizedTicketId);
  const nextTasks = sortLinkedTasks(tasks);

  await $db.set(buildDbKey(normalizedTicketId), {
    ticket_id: normalizedTicketId,
    tasks: nextTasks,
  });

  await syncReverseTaskLinks(normalizedTicketId, previous.tasks, nextTasks);
  await syncDashboardSummary(normalizedTicketId, previous.tasks, nextTasks);
}

async function readTrelloWebhookStore() {
  try {
    const stored = await $db.get(TRELLO_WEBHOOK_STORE_KEY);
    return {
      target_url: normalizeText(stored && stored.target_url),
      registrations: Array.isArray(stored && stored.registrations) ? stored.registrations : [],
    };
  } catch (error) {
    if (error && error.status === 404) {
      return {
        target_url: "",
        registrations: [],
      };
    }
    throw error;
  }
}

async function writeTrelloWebhookStore(targetUrl, registrations) {
  await $db.set(TRELLO_WEBHOOK_STORE_KEY, {
    target_url: normalizeText(targetUrl),
    registrations: Array.isArray(registrations) ? registrations : [],
  });
}

async function clearTrelloWebhookStore() {
  try {
    await $db.delete(TRELLO_WEBHOOK_STORE_KEY);
  } catch (error) {
    if (!(error && error.status === 404)) {
      throw error;
    }
  }
}

async function readTrelloRuntimeSettings() {
  try {
    const stored = await $db.get(TRELLO_RUNTIME_SETTINGS_KEY);
    return {
      trello_api_key: resolveTrelloApiKey(stored && stored.trello_api_key),
      trello_token: normalizeText(stored && stored.trello_token),
      trello_token_fingerprint: normalizeText(stored && stored.trello_token_fingerprint),
      trello_token_saved_at: normalizeText(stored && stored.trello_token_saved_at),
      domain: normalizeDomain(stored && stored.domain),
      api_key: normalizeText(stored && stored.api_key),
    };
  } catch (error) {
    if (error && error.status === 404) {
      return {
        trello_api_key: resolveTrelloApiKey(""),
        trello_token: "",
        trello_token_fingerprint: "",
        trello_token_saved_at: "",
        domain: "",
        api_key: "",
      };
    }
    throw error;
  }
}

async function writeTrelloRuntimeSettings(settings) {
  const nextSettings = {
    trello_api_key: resolveTrelloApiKey(settings && settings.trello_api_key),
    trello_token: normalizeText(settings && settings.trello_token),
    trello_token_fingerprint: normalizeText(settings && settings.trello_token_fingerprint),
    trello_token_saved_at: normalizeText(settings && settings.trello_token_saved_at),
    domain: normalizeDomain(settings && settings.domain),
    api_key: normalizeText(settings && settings.api_key),
  };

  await $db.set(TRELLO_RUNTIME_SETTINGS_KEY, nextSettings);
}

async function clearTrelloRuntimeSettings() {
  try {
    await $db.delete(TRELLO_RUNTIME_SETTINGS_KEY);
  } catch (error) {
    if (!(error && error.status === 404)) {
      throw error;
    }
  }
}

async function writeSuppression(prefix, recordId, windowMs, extra) {
  const normalizedRecordId = normalizeText(recordId);
  if (!normalizedRecordId) {
    return;
  }

  await $db.set(buildSuppressionKey(prefix, normalizedRecordId), {
    record_id: normalizedRecordId,
    until: Date.now() + Number(windowMs || SYNC_SUPPRESS_WINDOW_MS),
    ...(extra || {}),
  });
}

async function isSuppressed(prefix, recordId, eventTimestamp) {
  const normalizedRecordId = normalizeText(recordId);
  if (!normalizedRecordId) {
    return false;
  }

  try {
    const stored = await $db.get(buildSuppressionKey(prefix, normalizedRecordId));
    const until = Number(stored && stored.until) || 0;
    const comparisonTime = Number(eventTimestamp) || Date.now();

    return until > comparisonTime;
  } catch (error) {
    if (error && error.status === 404) {
      return false;
    }
    throw error;
  }
}

async function readDashboardSummary() {
  try {
    const stored = await $db.get(DASHBOARD_SUMMARY_KEY);
    return {
      total_linked_tickets: Number(stored && stored.total_linked_tickets) || 0,
      total_linked_tasks: Number(stored && stored.total_linked_tasks) || 0,
      tracked_ticket_ids: Array.isArray(stored && stored.tracked_ticket_ids) ? stored.tracked_ticket_ids : [],
    };
  } catch (error) {
    if (error && error.status === 404) {
      return {
        total_linked_tickets: 0,
        total_linked_tasks: 0,
        tracked_ticket_ids: [],
      };
    }
    throw error;
  }
}

async function readDashboardRecent() {
  try {
    const stored = await $db.get(DASHBOARD_RECENT_KEY);
    return Array.isArray(stored && stored.items) ? stored.items : [];
  } catch (error) {
    if (error && error.status === 404) {
      return [];
    }
    throw error;
  }
}

async function readDashboardTickets() {
  try {
    const stored = await $db.get(DASHBOARD_TICKETS_KEY);
    return Array.isArray(stored && stored.items) ? stored.items : [];
  } catch (error) {
    if (error && error.status === 404) {
      return [];
    }
    throw error;
  }
}

function buildRecentTaskEntries(ticketId, tasks) {
  return (Array.isArray(tasks) ? tasks : []).map((task) => ({
    ticket_id: normalizeText(ticketId),
    task_id: normalizeText(task && task.task_id),
    task_name: normalizeText(task && task.task_name),
    task_url: normalizeText(task && task.task_url),
    workspace_name: normalizeText(task && task.workspace_name),
    space_name: normalizeText(task && task.space_name),
    list_name: normalizeText(task && task.list_name),
    priority_label: normalizeText(task && task.priority_label),
    status: normalizeText(task && task.status),
    linked_at: normalizeText(task && task.linked_at),
    last_synced_at: normalizeText(task && task.last_synced_at),
    last_sync_error: normalizeText(task && task.last_sync_error),
  }));
}

function sortRecentEntries(items) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item && normalizeText(item.ticket_id) && normalizeText(item.task_id))
    .sort((left, right) => {
      const leftTime = new Date(left.last_synced_at || left.linked_at || 0).getTime();
      const rightTime = new Date(right.last_synced_at || right.linked_at || 0).getTime();
      return rightTime - leftTime;
    });
}

function sortDashboardTickets(items) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item && normalizeText(item.ticket_id))
    .sort((left, right) => {
      const leftTime = new Date(left.last_activity_at || 0).getTime();
      const rightTime = new Date(right.last_activity_at || 0).getTime();
      return rightTime - leftTime;
    });
}

function buildDashboardTicketEntry(ticketId, tasks) {
  const items = Array.isArray(tasks) ? tasks : [];
  const latestTask = sortLinkedTasks(items)[0] || {};
  const syncErrors = items
    .map((task) => normalizeText(task && task.last_sync_error))
    .filter(Boolean);

  return {
    ticket_id: normalizeText(ticketId),
    task_count: items.length,
    latest_task_name: normalizeText(latestTask.task_name),
    latest_task_url: normalizeText(latestTask.task_url),
    workspace_name: normalizeText(latestTask.workspace_name),
    space_name: normalizeText(latestTask.space_name),
    list_name: normalizeText(latestTask.list_name),
    last_activity_at: normalizeText(latestTask.last_synced_at || latestTask.linked_at),
    has_sync_error: syncErrors.length > 0,
    sync_error: syncErrors[0] || "",
  };
}

async function syncDashboardSummary(ticketId, previousTasks, nextTasks) {
  const previous = Array.isArray(previousTasks) ? previousTasks : [];
  const next = Array.isArray(nextTasks) ? nextTasks : [];

  const summary = await readDashboardSummary();
  const recent = await readDashboardRecent();
  const tickets = await readDashboardTickets();
  const trackedTicketIds = Array.isArray(summary.tracked_ticket_ids) ? summary.tracked_ticket_ids.slice() : [];

  const previouslyLinked = previous.length > 0;
  const currentlyLinked = next.length > 0;
  let totalLinkedTickets = summary.total_linked_tickets;
  let nextTrackedTicketIds = trackedTicketIds.filter((id) => normalizeText(id) !== normalizeText(ticketId));

  if (!previouslyLinked && currentlyLinked) {
    totalLinkedTickets += 1;
  } else if (previouslyLinked && !currentlyLinked) {
    totalLinkedTickets = Math.max(0, totalLinkedTickets - 1);
  }

  if (currentlyLinked) {
    nextTrackedTicketIds.push(normalizeText(ticketId));
  }

  const totalLinkedTasks = Math.max(
    0,
    summary.total_linked_tasks + next.length - previous.length
  );

  const filteredRecent = recent.filter((item) => {
    return normalizeText(item && item.ticket_id) !== normalizeText(ticketId);
  });
  const nextRecent = sortRecentEntries(filteredRecent.concat(buildRecentTaskEntries(ticketId, next))).slice(
    0,
    DASHBOARD_RECENT_LIMIT
  );
  const filteredTickets = tickets.filter((item) => {
    return normalizeText(item && item.ticket_id) !== normalizeText(ticketId);
  });
  const nextTicketEntries = currentlyLinked
    ? sortDashboardTickets(filteredTickets.concat(buildDashboardTicketEntry(ticketId, next)))
    : sortDashboardTickets(filteredTickets);

  await $db.set(DASHBOARD_SUMMARY_KEY, {
    total_linked_tickets: totalLinkedTickets,
    total_linked_tasks: totalLinkedTasks,
    tracked_ticket_ids: nextTrackedTicketIds,
  });

  await $db.set(DASHBOARD_RECENT_KEY, {
    items: nextRecent,
  });

  await $db.set(DASHBOARD_TICKETS_KEY, {
    items: nextTicketEntries,
  });
}

async function invokeTemplate(name, context, body) {
  const requestOptions = {
    context: context || {},
  };

  if (body !== undefined) {
    requestOptions.body = JSON.stringify(body);
  }

  const response = await $request.invokeTemplate(name, requestOptions);

  return {
    status: Number(response && response.status) || 0,
    headers: (response && response.headers) || {},
    data: safeParseJson(response && response.response, response && response.response),
    raw: response && response.response,
  };
}

function extractErrorMessage(error, fallback) {
  if (!error) {
    return fallback || "Unknown error.";
  }

  if (typeof error === "string") {
    return error;
  }

  if (error.message) {
    return error.message;
  }

  if (error.response) {
    const parsed = safeParseJson(error.response, null);
    if (parsed && parsed.err) {
      return normalizeText(parsed.err);
    }
    if (parsed && parsed.message) {
      return normalizeText(parsed.message);
    }
    const rawResponseText = normalizeText(error.response);
    if (rawResponseText) {
      return rawResponseText;
    }
  }

  if (error.raw) {
    const rawText = normalizeText(error.raw);
    if (rawText) {
      return rawText;
    }
  }

  try {
    return JSON.stringify(error);
  } catch {
    return fallback || "Unknown error.";
  }
}

function isInvalidTrelloTokenError(error) {
  const message = extractErrorMessage(error, "").toLowerCase();
  return message.includes("invalid token");
}

function ensureSuccess(response, fallbackMessage) {
  if (response.status >= 200 && response.status < 300) {
    return response.data;
  }

  const parsed = safeParseJson(response.raw, {});
  const detail =
    normalizeText(parsed && parsed.err) ||
    normalizeText(parsed && parsed.message) ||
    normalizeText(parsed && parsed.error) ||
    fallbackMessage ||
    "Request failed.";

  throw new Error(detail);
}

function buildSuccess(data) {
  return renderData(null, {
    success: true,
    ...(data || {}),
  });
}

function buildFailure(message, error) {
  return renderData({
    success: false,
    message,
    detail: extractErrorMessage(error, message),
  });
}

function normalizeWorkspace(item) {
  const id = normalizeText(item && item.id);
  if (!id) {
    return null;
  }

  return {
    id,
    name: normalizeText(item && item.name) || `Workspace ${id}`,
    members: normalizeWorkspaceMembers(item && item.members),
  };
}

function normalizeWorkspaceMembers(items) {
  return (Array.isArray(items) ? items : [])
    .map((member) => normalizeAssignee(member && member.user ? member.user : member))
    .filter(Boolean);
}

function normalizeSpace(item) {
  const id = normalizeText(item && item.id);
  if (!id) {
    return null;
  }

  return {
    id,
    name: normalizeText(item && item.name) || `Space ${id}`,
  };
}

function normalizeList(item) {
  const id = normalizeText(item && item.id);
  if (!id) {
    return null;
  }

  return {
    id,
    name: normalizeText(item && item.name) || `List ${id}`,
  };
}

function normalizeTrelloBoard(item) {
  const id = normalizeText(item && item.id);
  if (!id) {
    return null;
  }

  return {
    id,
    name: normalizeText(item && item.name) || `Board ${id}`,
    url: normalizeText(item && item.url),
  };
}

function normalizeTrelloList(item) {
  const id = normalizeText(item && item.id);
  if (!id) {
    return null;
  }

  return {
    id,
    name: normalizeText(item && item.name) || `List ${id}`,
  };
}

function normalizeTrelloLabels(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      if (!item) {
        return null;
      }
      if (typeof item === "string") {
        const text = normalizeText(item);
        return text ? { id: "", name: text, color: "" } : null;
      }
      const id = normalizeText(item.id);
      const name = normalizeText(item.name);
      const color = normalizeText(item.color);
      return (id || name || color) ? { id, name, color } : null;
    })
    .filter(Boolean);
}

function normalizeTrelloMember(item) {
  const id = normalizeText(item && item.id);
  if (!id) {
    return null;
  }

  return {
    id,
    name: normalizeText(item && (item.fullName || item.username || item.name)) || `Member ${id}`,
    username: normalizeText(item && item.username),
    avatar_url: normalizeText(item && item.avatarUrl),
  };
}

function normalizeTrelloLabel(item) {
  const id = normalizeText(item && item.id);
  if (!id) {
    return null;
  }

  return {
    id,
    name: normalizeText(item && item.name),
    color: normalizeText(item && item.color),
  };
}

function normalizeTrelloCardRecord(card, meta) {
  const cardId = normalizeText(card && card.id ? card.id : meta && meta.task_id);
  if (!cardId) {
    return null;
  }

  const cardLabels = Array.isArray(card && card.labels) ? card.labels : null;
  const labels = normalizeTrelloLabels(
    (cardLabels && cardLabels.length) ? cardLabels : (meta && meta.labels)
  );

  const cardMembers = Array.isArray(card && card.members) ? card.members : [];
  const assignees = cardMembers.length
    ? normalizeAssignees(cardMembers)
    : normalizeAssignees(meta && meta.assignees);

  const isClosed = Boolean(card && card.closed);

  return {
    task_id: cardId,
    task_name: normalizeText(card && card.name) || normalizeText(meta && meta.task_name) || `Card ${cardId}`,
    task_url: normalizeText(card && card.url) || normalizeText(meta && meta.task_url),
    workspace_id: normalizeText(meta && meta.workspace_id),
    workspace_name: normalizeText(meta && meta.workspace_name),
    space_id: "",
    space_name: "",
    list_id: normalizeText(meta && meta.list_id) || normalizeText(card && card.idList),
    list_name: normalizeText(meta && meta.list_name),
    priority: "",
    priority_label: labels.map((l) => l.name || l.color).filter(Boolean).join(", "),
    status: isClosed ? "Archived" : "Open",
    due_date: normalizeDueDate(card && card.due ? card.due : meta && meta.due_date),
    assignees,
    linked_at: normalizeText(meta && meta.linked_at) || new Date().toISOString(),
    source: normalizeText(meta && meta.source) || "linked",
    last_synced_at: normalizeText(meta && meta.last_synced_at),
    last_sync_error: normalizeText(meta && meta.last_sync_error),
    labels,
  };
}

function sanitizeTrelloCardLinkPayload(card, meta) {
  return normalizeTrelloCardRecord(
    {
      id: card && (card.task_id || card.card_id || card.id),
      name: card && (card.task_name || card.card_name || card.name),
      url: card && (card.task_url || card.card_url || card.url),
      due: card && (card.due_date || card.due),
      labels: card && card.labels,
      closed: Boolean(card && (card.closed || normalizeText(card.status).toLowerCase() === "archived")),
      idList: card && (card.list_id || card.idList),
    },
    {
      workspace_id: normalizeText(meta && meta.workspace_id),
      workspace_name: normalizeText(meta && meta.workspace_name),
      list_id: normalizeText(meta && meta.list_id),
      list_name: normalizeText(meta && meta.list_name),
      linked_at: new Date().toISOString(),
      source: normalizeText(meta && meta.source) || "linked",
    }
  );
}

function buildTrelloCardPayloadFromTicket(ticket) {
  const payload = {};
  const subject = normalizeText(ticket && ticket.subject);
  const description = buildTaskDescription(ticket);

  if (subject) {
    payload.name = subject;
  }

  if (description) {
    payload.desc = description;
  }

  return payload;
}

function applySyncedTicketDetailsToCard(task, ticket, syncTimestamp) {
  return {
    ...task,
    task_name: normalizeText(ticket && ticket.subject) || task.task_name,
    last_synced_at: syncTimestamp,
    last_sync_error: "",
  };
}

function resolveClickupPriorityValue(priority) {
  if (priority === null || priority === undefined || priority === "") {
    return "";
  }

  if (typeof priority === "number") {
    return CLICKUP_PRIORITY_LABELS[String(priority)] ? String(priority) : "";
  }

  if (typeof priority === "string") {
    const normalized = normalizeText(priority);
    if (CLICKUP_PRIORITY_LABELS[normalized]) {
      return normalized;
    }

    const lookup = Object.entries(CLICKUP_PRIORITY_LABELS).find((entry) => {
      return entry[1].toLowerCase() === normalized.toLowerCase();
    });
    return lookup ? lookup[0] : "";
  }

  if (typeof priority === "object") {
    const candidateValues = [
      priority.id,
      priority.orderindex,
      priority.priority,
      priority.value,
    ];

    for (let index = 0; index < candidateValues.length; index += 1) {
      const resolved = resolveClickupPriorityValue(candidateValues[index]);
      if (resolved) {
        return resolved;
      }
    }
  }

  return "";
}

function resolveClickupPriorityLabel(priority) {
  const value = resolveClickupPriorityValue(priority);
  return CLICKUP_PRIORITY_LABELS[value] || "";
}

function normalizeAssignee(item) {
  const id = normalizeText(item && (item.id || item.userid || item.user_id || item.assignee));
  if (!id) {
    return null;
  }

  return {
    id,
    name:
      normalizeText(item && (item.fullName || item.name || item.username || item.email)) ||
      `User ${id}`,
    email: normalizeText(item && item.email),
  };
}

function normalizeAssignees(items) {
  return (Array.isArray(items) ? items : [])
    .map(normalizeAssignee)
    .filter(Boolean);
}

function normalizeDueDate(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }

  const timestamp = Number(normalized);
  if (!Number.isNaN(timestamp)) {
    try {
      return new Date(timestamp).toISOString();
    } catch {
      return "";
    }
  }

  return normalized;
}

function buildTaskUrl(taskId, taskUrl) {
  return normalizeText(taskUrl) || `https://app.clickup.com/t/${normalizeText(taskId)}`;
}

function normalizeTaskRecord(task, meta) {
  const taskId = normalizeText(task && task.id ? task.id : meta && meta.task_id);
  if (!taskId) {
    return null;
  }

  const priorityValue = resolveClickupPriorityValue(task && task.priority ? task.priority : meta && meta.priority);
  const statusValue =
    normalizeText(task && task.status && (task.status.status || task.status.type || task.status.label)) ||
    normalizeText(meta && meta.status);

  return {
    task_id: taskId,
    task_name:
      normalizeText(task && task.name) ||
      normalizeText(meta && meta.task_name) ||
      `Task ${taskId}`,
    task_url: buildTaskUrl(taskId, task && task.url ? task.url : meta && meta.task_url),
    workspace_id: normalizeText(meta && meta.workspace_id),
    workspace_name: normalizeText(meta && meta.workspace_name),
    space_id: normalizeText(meta && meta.space_id),
    space_name: normalizeText(meta && meta.space_name),
    list_id:
      normalizeText(meta && meta.list_id) ||
      normalizeText(task && task.list && task.list.id),
    list_name:
      normalizeText(meta && meta.list_name) ||
      normalizeText(task && task.list && task.list.name),
    priority: priorityValue,
    priority_label: CLICKUP_PRIORITY_LABELS[priorityValue] || resolveClickupPriorityLabel(task && task.priority),
    status: statusValue,
    due_date: normalizeDueDate(task && task.due_date ? task.due_date : meta && meta.due_date),
    assignees: normalizeAssignees(task && task.assignees ? task.assignees : meta && meta.assignees),
    linked_at: normalizeText(meta && meta.linked_at) || new Date().toISOString(),
    source: normalizeText(meta && meta.source) || "linked",
    last_synced_at: normalizeText(meta && meta.last_synced_at),
    last_sync_error: normalizeText(meta && meta.last_sync_error),
  };
}

function sortLinkedTasks(tasks) {
  return (Array.isArray(tasks) ? tasks : [])
    .filter((task) => task && normalizeText(task.task_id))
    .sort((left, right) => {
      return new Date(right.linked_at || 0).getTime() - new Date(left.linked_at || 0).getTime();
    });
}

function upsertLinkedTask(tasks, taskRecord) {
  const filtered = (Array.isArray(tasks) ? tasks : []).filter((task) => {
    return normalizeText(task && task.task_id) !== normalizeText(taskRecord && taskRecord.task_id);
  });

  return sortLinkedTasks(filtered.concat(taskRecord));
}

function convertDateInputToTimestamp(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  const date = new Date(`${normalized}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function sanitizeMemberRecord(member) {
  const normalized = normalizeAssignee(member);
  if (!normalized) {
    return null;
  }

  return normalized;
}

function sanitizeTaskLinkPayload(task, meta) {
  return normalizeTaskRecord(
    {
      id: task && (task.task_id || task.id),
      name: task && (task.task_name || task.name),
      url: task && (task.task_url || task.url),
      priority: task && task.priority,
      due_date: task && task.due_date,
      assignees: task && task.assignees,
      status: task && task.status ? { status: task.status } : null,
    },
    {
      workspace_id: meta.workspace_id,
      workspace_name: meta.workspace_name,
      space_id: meta.space_id,
      space_name: meta.space_name,
      list_id: meta.list_id,
      list_name: meta.list_name,
      source: normalizeText(meta.source) || "linked",
      linked_at: new Date().toISOString(),
    }
  );
}

function buildTaskDescription(ticket) {
  const descriptionText = normalizeText(ticket && ticket.description_text);
  if (descriptionText) {
    return descriptionText;
  }

  return stripHtml(ticket && ticket.description);
}

function normalizeStatusValue(status) {
  if (status === null || status === undefined || status === "") {
    return "";
  }

  if (typeof status === "number") {
    return String(status);
  }

  if (typeof status === "string") {
    return normalizeText(status).toLowerCase();
  }

  if (typeof status === "object") {
    const candidateValues = [
      status.id,
      status.value,
      status.name,
      status.label,
      status.status,
    ];

    for (let index = 0; index < candidateValues.length; index += 1) {
      const resolved = normalizeStatusValue(candidateValues[index]);
      if (resolved) {
        return resolved;
      }
    }
  }

  return "";
}

function resolveClickupStatusForFreshdeskStatus(status) {
  const normalizedStatus = normalizeStatusValue(status);

  if (["4", "resolved", "5", "closed"].includes(normalizedStatus)) {
    return "complete";
  }

  return "";
}

function mapFreshdeskPriorityToClickup(priority) {
  if (priority === null || priority === undefined || priority === "") {
    return null;
  }

  if (typeof priority === "number") {
    return FRESHDESK_TO_CLICKUP_PRIORITY[String(priority)] || null;
  }

  if (typeof priority === "string") {
    const normalized = normalizeText(priority).toLowerCase();
    if (FRESHDESK_TO_CLICKUP_PRIORITY[normalized]) {
      return FRESHDESK_TO_CLICKUP_PRIORITY[normalized];
    }

    const labelMap = {
      low: 4,
      medium: 3,
      normal: 3,
      high: 2,
      urgent: 1,
    };

    return labelMap[normalized] || FRESHDESK_TO_CLICKUP_PRIORITY[normalizeText(priority)] || null;
  }

  if (typeof priority === "object") {
    const candidateValues = [
      priority.id,
      priority.value,
      priority.name,
      priority.label,
      priority.priority,
    ];

    for (let index = 0; index < candidateValues.length; index += 1) {
      const resolved = mapFreshdeskPriorityToClickup(candidateValues[index]);
      if (resolved) {
        return resolved;
      }
    }
  }

  return null;
}

function buildTicketSyncPayload(ticket) {
  const updatePayload = {};
  const subject = normalizeText(ticket && ticket.subject);
  const description = buildTaskDescription(ticket);
  const priority = mapFreshdeskPriorityToClickup(ticket && ticket.priority);
  const status = resolveClickupStatusForFreshdeskStatus(ticket && ticket.status);

  if (subject) {
    updatePayload.name = subject;
  }

  if (description) {
    updatePayload.description = description;
  }

  if (priority) {
    updatePayload.priority = priority;
  }

  if (status) {
    updatePayload.status = status;
  }

  return updatePayload;
}

function normalizeDomain(value) {
  return normalizeText(value).replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

function resolveSettings(payload) {
  if (payload && payload.iparams && typeof payload.iparams === "object") {
    return payload.iparams;
  }
  if (payload && payload.app_settings && typeof payload.app_settings === "object") {
    return payload.app_settings;
  }
  return {};
}

function getFreshdeskContextFromSettings(settings) {
  return {
    domain: normalizeDomain(settings && settings.domain),
    encoded_auth: normalizeText(settings && settings.api_key),
  };
}

function resolveTrelloApiKey(value) {
  return normalizeText(value) || TRELLO_APP_KEY;
}

async function buildTrelloRequestContext(context, trelloApiKey, trelloToken, diagnostics) {
  const runtime = await readTrelloRuntimeSettings();
  return {
    ...(context || {}),
    trello_api_key: resolveTrelloApiKey(trelloApiKey || runtime.trello_api_key),
    trello_token: normalizeText(trelloToken || runtime.trello_token),
    trello_token_fingerprint:
      normalizeText(diagnostics && diagnostics.trello_token_fingerprint) || runtime.trello_token_fingerprint,
    trello_token_saved_at:
      normalizeText(diagnostics && diagnostics.trello_token_saved_at) || runtime.trello_token_saved_at,
  };
}

function extractExternalPayload(payload) {
  if (payload && payload.data && typeof payload.data === "object") {
    return payload.data;
  }

  if (payload && payload.payload && typeof payload.payload === "object") {
    return payload.payload;
  }

  return payload && typeof payload === "object" ? payload : {};
}

function looksLikeClickupComment(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      (
        normalizeText(value.id) ||
        normalizeText(value.text) ||
        Array.isArray(value.comment) ||
        (value.user && typeof value.user === "object")
      )
  );
}

function getClickupEventName(payload) {
  const external = extractExternalPayload(payload);
  return normalizeText(
    external && (
      external.event ||
      external.event_type ||
      external.type
    )
  );
}

function getClickupEventTaskId(payload) {
  const external = extractExternalPayload(payload);
  const historyItems = Array.isArray(external && external.history_items) ? external.history_items : [];

  const candidates = [
    external && external.task_id,
    external && external.taskId,
    external && external.item_id,
    external && external.itemId,
    external && external.task && external.task.id,
    external && external.task && external.task.task_id,
    historyItems[0] && historyItems[0].task_id,
    historyItems[0] && historyItems[0].parent_id,
  ];

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = normalizeText(candidates[index]);
    if (candidate) {
      return candidate;
    }
  }

  return "";
}

function isSupportedClickupReverseEvent(eventName) {
  return CLICKUP_COMMENT_REVERSE_EVENTS.has(normalizeText(eventName));
}

function normalizeStringList(items) {
  return Array.from(new Set((Array.isArray(items) ? items : []).map(normalizeText).filter(Boolean)));
}

function getStoredTaskRecord(storedTasks, taskId) {
  return (Array.isArray(storedTasks) ? storedTasks : []).find((task) => {
    return normalizeText(task && task.task_id) === normalizeText(taskId);
  }) || null;
}

function getStoredTaskCommentIds(taskRecord) {
  return normalizeStringList(taskRecord && taskRecord.synced_comment_ids);
}

function extractClickupCommentText(comment) {
  const items = Array.isArray(comment && comment.comment) ? comment.comment : [];
  const text = items
    .map((item) => normalizeText(item && item.text))
    .filter(Boolean)
    .join("");

  return text || normalizeText(comment && comment.text);
}

function isFreshdeskMirroredClickupComment(comment) {
  const text = extractClickupCommentText(comment);
  return /^\[Freshdesk (Private Note|Customer Reply|Agent Reply)\]/.test(text);
}

function buildClickupCommentNoteBody(taskPayload, comment) {
  const taskName = normalizeText(taskPayload && taskPayload.name) || `Task ${normalizeText(taskPayload && taskPayload.id)}`;
  const taskUrl = normalizeText(taskPayload && taskPayload.url);
  const author =
    normalizeText(
      comment &&
        comment.user &&
        (comment.user.username || comment.user.email || comment.user.name)
    ) || "ClickUp user";
  const commentText = escapeHtml(extractClickupCommentText(comment));
  const taskLabel = taskUrl
    ? `<a href="${escapeHtml(taskUrl)}" target="_blank" rel="noreferrer">${escapeHtml(taskName)}</a>`
    : escapeHtml(taskName);

  return [
    `<p><strong>ClickUp Comment</strong> from ${escapeHtml(author)} on ${taskLabel}</p>`,
    commentText ? `<p>${commentText.replace(/\n/g, "<br />")}</p>` : "",
  ]
    .filter(Boolean)
    .join("");
}

function buildTaskMetaFromStoredRecord(taskRecord) {
  return {
    workspace_id: normalizeText(taskRecord && taskRecord.workspace_id),
    workspace_name: normalizeText(taskRecord && taskRecord.workspace_name),
    space_id: normalizeText(taskRecord && taskRecord.space_id),
    space_name: normalizeText(taskRecord && taskRecord.space_name),
    list_id: normalizeText(taskRecord && taskRecord.list_id),
    list_name: normalizeText(taskRecord && taskRecord.list_name),
    source: normalizeText(taskRecord && taskRecord.source) || "linked",
    linked_at: normalizeText(taskRecord && taskRecord.linked_at) || new Date().toISOString(),
    last_sync_error: normalizeText(taskRecord && taskRecord.last_sync_error),
    last_synced_at: normalizeText(taskRecord && taskRecord.last_synced_at),
    synced_comment_ids: getStoredTaskCommentIds(taskRecord),
  };
}

function buildTrelloTaskMetaFromStoredRecord(taskRecord) {
  return {
    workspace_id: normalizeText(taskRecord && taskRecord.workspace_id),
    workspace_name: normalizeText(taskRecord && taskRecord.workspace_name),
    list_id: normalizeText(taskRecord && taskRecord.list_id),
    list_name: normalizeText(taskRecord && taskRecord.list_name),
    assignees: normalizeAssignees(taskRecord && taskRecord.assignees),
    labels: Array.isArray(taskRecord && taskRecord.labels) ? taskRecord.labels : [],
    linked_at: normalizeText(taskRecord && taskRecord.linked_at) || new Date().toISOString(),
    source: normalizeText(taskRecord && taskRecord.source) || "linked",
    last_sync_error: normalizeText(taskRecord && taskRecord.last_sync_error),
    last_synced_at: normalizeText(taskRecord && taskRecord.last_synced_at),
    labels: Array.isArray(taskRecord && taskRecord.labels) ? taskRecord.labels : [],
    task_name: normalizeText(taskRecord && taskRecord.task_name),
    task_url: normalizeText(taskRecord && taskRecord.task_url),
    due_date: normalizeText(taskRecord && taskRecord.due_date),
  };
}

function findTrelloWebhookRegistration(registrations, cardId) {
  const normalizedCardId = normalizeText(cardId);
  return (Array.isArray(registrations) ? registrations : []).find((registration) => {
    return normalizeText(registration && registration.card_id) === normalizedCardId;
  }) || null;
}

async function cleanupRegisteredTrelloWebhooks(registrations, trelloApiKey) {
  const items = Array.isArray(registrations) ? registrations : [];

  for (let index = 0; index < items.length; index += 1) {
    const registration = items[index];
    const webhookId = normalizeText(registration && registration.webhook_id);

    if (!webhookId) {
      continue;
    }

    try {
      await invokeTemplate(
        "trello_webhook_delete",
        await buildTrelloRequestContext(
          {
            webhook_id: webhookId,
          },
          trelloApiKey
        )
      );
    } catch (error) {
      console.error("Failed to delete Trello webhook:", webhookId, error);
    }
  }
}

async function registerTrelloWebhook(cardRecord, targetUrl, trelloApiKey) {
  const cardId = normalizeText(cardRecord && cardRecord.task_id);
  const endpoint = normalizeText(targetUrl);

  if (!cardId) {
    throw new Error("Card ID is required for Trello webhook setup.");
  }

  if (!endpoint) {
    throw new Error("Webhook target URL is not available.");
  }

  const payload = ensureSuccess(
    await invokeTemplate("trello_webhook_create", await buildTrelloRequestContext({}, trelloApiKey), {
      description: `Freshdesk Trello Connector webhook for card ${cardId}`,
      callbackURL: endpoint,
      idModel: cardId,
    }),
    "Could not register the Trello webhook."
  );

  return {
    webhook_id: normalizeText(payload && payload.id),
    card_id: cardId,
    board_id: normalizeText(cardRecord && cardRecord.workspace_id),
    list_id: normalizeText(cardRecord && cardRecord.list_id),
    endpoint,
    registered_at: new Date().toISOString(),
  };
}

async function ensureTrelloWebhookRegistration(cardRecord, trelloApiKey) {
  const cardId = normalizeText(cardRecord && cardRecord.task_id);
  if (!cardId) {
    return null;
  }

  const store = await readTrelloWebhookStore();
  const targetUrl = normalizeText(store && store.target_url);

  if (!targetUrl) {
    throw new Error("Webhook callback URL is not available yet. Update the app settings once to finish webhook setup.");
  }

  const existing = findTrelloWebhookRegistration(store.registrations, cardId);

  if (existing && normalizeText(existing.endpoint || store.target_url) === targetUrl) {
    return existing;
  }

  if (existing && normalizeText(existing.webhook_id)) {
    try {
      await invokeTemplate(
        "trello_webhook_delete",
        await buildTrelloRequestContext(
          {
            webhook_id: normalizeText(existing.webhook_id),
          },
          trelloApiKey
        )
      );
    } catch (error) {
      console.error("Failed to refresh stale Trello webhook registration:", existing.webhook_id, error);
    }
  }

  const registration = await registerTrelloWebhook(cardRecord, targetUrl, trelloApiKey);
  const remaining = (store.registrations || []).filter((item) => {
    return normalizeText(item && item.card_id) !== cardId;
  });

  await writeTrelloWebhookStore(targetUrl, remaining.concat(registration));
  return registration;
}

async function cleanupTrelloWebhookIfUnused(cardId, trelloApiKey) {
  const normalizedCardId = normalizeText(cardId);
  if (!normalizedCardId) {
    return;
  }

  const reverseLinks = await readTaskLinks(normalizedCardId);
  if (reverseLinks.ticket_ids.length) {
    return;
  }

  const store = await readTrelloWebhookStore();
  const registration = findTrelloWebhookRegistration(store.registrations, normalizedCardId);

  if (!registration) {
    return;
  }

  try {
    if (normalizeText(registration.webhook_id)) {
      await invokeTemplate(
        "trello_webhook_delete",
        await buildTrelloRequestContext(
          {
            webhook_id: normalizeText(registration.webhook_id),
          },
          trelloApiKey
        )
      );
    }
  } catch (error) {
    console.error("Failed to clean up unused Trello webhook:", normalizedCardId, error);
  }

  await writeTrelloWebhookStore(
    store.target_url,
    (store.registrations || []).filter((item) => normalizeText(item && item.card_id) !== normalizedCardId)
  );
}

function applySyncedTicketDetails(task, ticket, syncTimestamp) {
  const mappedPriority = mapFreshdeskPriorityToClickup(ticket && ticket.priority);

  return {
    ...task,
    task_name: normalizeText(ticket && ticket.subject) || task.task_name,
    priority: mappedPriority ? String(mappedPriority) : task.priority,
    priority_label: mappedPriority ? CLICKUP_PRIORITY_LABELS[String(mappedPriority)] : task.priority_label,
    last_synced_at: syncTimestamp,
    last_sync_error: "",
  };
}

function getEventIparams(payload) {
  return resolveSettings(payload);
}

function normalizeBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value;
  }

  const normalized = normalizeText(value).toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }

  return fallback;
}

function isAutomaticSyncEnabled(payload) {
  return normalizeBoolean(getEventIparams(payload).automatic_sync_enabled, true);
}

function resolveClickupCommentSyncMode(settings) {
  const mode = normalizeText(settings && settings.clickup_comment_sync_mode).toLowerCase();
  if (["none", "public", "private"].includes(mode)) {
    return mode;
  }

  return "private";
}

function parseNotificationConfig(value) {
  if (!value) {
    return {};
  }

  if (typeof value === "object" && !Array.isArray(value)) {
    return value;
  }

  return safeParseJson(value, {});
}

function resolveTrelloToFreshdeskNotifications(settings) {
  const fallback = normalizeText(settings && settings.trello_to_freshdesk_sync_mode).toLowerCase() || "none";
  const allowed = new Set(["none", "private_note_notify", "public_note"]);
  const parsed = parseNotificationConfig(settings && settings.trello_to_freshdesk_notifications);
  const output = {};

  [
    "ticket_linked",
    "card_moved",
    "card_comment_added",
    "card_member_added",
    "card_labels_updated",
    "card_due_date_updated",
    "card_attachment_added",
    "card_archived",
  ].forEach((key) => {
    const value = normalizeText(parsed && parsed[key]).toLowerCase();
    output[key] = allowed.has(value) ? value : fallback;
  });

  return output;
}

function resolveFreshdeskToTrelloNotifications(settings) {
  const fallback = normalizeText(settings && settings.freshdesk_to_trello_sync_mode).toLowerCase() || "none";
  const allowed = new Set(["none", "comment"]);
  const parsed = parseNotificationConfig(settings && settings.freshdesk_to_trello_notifications);
  const output = {};

  [
    "ticket_linked",
    "private_note_added",
    "public_note_added",
    "agent_reply_added",
    "ticket_forwarded",
  ].forEach((key) => {
    const value = normalizeText(parsed && parsed[key]).toLowerCase();
    output[key] = allowed.has(value) ? value : fallback;
  });

  return output;
}

function getTrelloToFreshdeskNotificationAction(settings, eventKey) {
  return resolveTrelloToFreshdeskNotifications(settings)[normalizeText(eventKey)] || "none";
}

function getFreshdeskToTrelloNotificationAction(settings, eventKey) {
  return resolveFreshdeskToTrelloNotifications(settings)[normalizeText(eventKey)] || "none";
}

function normalizeEventTicket(payload) {
  const conversation = normalizeEventConversation(payload);
  const actor = (payload && payload.data && payload.data.actor) || {};
  const ticket =
    (payload && payload.data && payload.data.ticket) ||
    (payload && payload.ticket) ||
    {};

  return {
    id: normalizeText(
      ticket.id ||
        ticket.ticket_id ||
        conversation.ticket_id ||
        conversation.ticketId ||
        actor.ticket_id ||
        actor.ticketId
    ),
    subject: normalizeText(ticket.subject),
    description_text: normalizeText(ticket.description_text || ticket.descriptionText || stripHtml(ticket.description)),
    description: normalizeText(ticket.description),
    priority: normalizeText(ticket.priority),
    status: normalizeText(ticket.status),
  };
}

function normalizeEventConversation(payload) {
  return (
    (payload && payload.data && payload.data.conversation) ||
    payload.conversation ||
    (payload && payload.data && payload.data.actor) ||
    {}
  );
}

function normalizeFieldMappings(value) {
  const list = Array.isArray(value) ? value : safeParseJson(value, []);
  return (Array.isArray(list) ? list : [])
    .map((mapping) => ({
      freshdesk_field_name: normalizeText(mapping && mapping.freshdesk_field_name),
      freshdesk_field_key: normalizeText(mapping && mapping.freshdesk_field_key),
      clickup_field_id: normalizeText(mapping && mapping.clickup_field_id),
      clickup_field_type: normalizeText(mapping && mapping.clickup_field_type),
      clickup_field_type_config:
        mapping && mapping.clickup_field_type_config && typeof mapping.clickup_field_type_config === "object"
          ? mapping.clickup_field_type_config
          : safeParseJson(mapping && mapping.clickup_field_type_config, {}),
    }))
    .filter((mapping) => mapping.freshdesk_field_key && mapping.clickup_field_id);
}

function normalizeTicketCustomFields(value) {
  if (!value || typeof value !== "object") {
    return {};
  }

  return value;
}

function buildFreshdeskFieldLookupTokens(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return [];
  }

  const compact = normalized.toLowerCase();
  const slug = compact
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const unprefixed = slug.startsWith("cf_") ? slug.slice(3) : slug;

  return Array.from(
    new Set(
      [normalized, compact, slug, `cf_${slug}`, unprefixed, `cf_${unprefixed}`].filter(Boolean)
    )
  );
}

function getCanonicalFreshdeskFieldToken(value) {
  const tokens = buildFreshdeskFieldLookupTokens(value);
  return tokens.find((token) => token.startsWith("cf_")) || tokens.find(Boolean) || "";
}

function getMappedFreshdeskFieldValue(mapping, ticketCustomFields) {
  const customFields = normalizeTicketCustomFields(ticketCustomFields);
  const entries = Object.entries(customFields);

  if (!entries.length) {
    return undefined;
  }

  const directTokens = [
    ...buildFreshdeskFieldLookupTokens(mapping && mapping.freshdesk_field_key),
    ...buildFreshdeskFieldLookupTokens(mapping && mapping.freshdesk_field_name),
  ];

  for (let index = 0; index < directTokens.length; index += 1) {
    const token = directTokens[index];
    if (Object.prototype.hasOwnProperty.call(customFields, token)) {
      return customFields[token];
    }
  }

  const normalizedLookup = new Map(entries.map(([key, value]) => [getCanonicalFreshdeskFieldToken(key), value]));

  for (let index = 0; index < directTokens.length; index += 1) {
    const token = directTokens[index];
    const normalizedToken = getCanonicalFreshdeskFieldToken(token);
    if (normalizedLookup.has(normalizedToken)) {
      return normalizedLookup.get(normalizedToken);
    }
  }

  return undefined;
}

function normalizeBooleanValue(value) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return null;
  }

  if (["true", "yes", "y", "1", "checked", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "no", "n", "0", "unchecked", "off"].includes(normalized)) {
    return false;
  }

  return null;
}

function parseNumberValue(value) {
  if (typeof value === "number") {
    return Number.isNaN(value) ? null : value;
  }

  const normalized = normalizeText(value).replace(/,/g, "");
  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseDateValue(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function findOptionId(options, rawValue) {
  const normalizedRaw = normalizeText(rawValue);
  if (!normalizedRaw) {
    return null;
  }

  const items = Array.isArray(options) ? options : [];
  const directMatch = items.find((option) => normalizeText(option && option.id) === normalizedRaw);
  if (directMatch) {
    return normalizeText(directMatch.id);
  }

  const labelMatch = items.find((option) => {
    return normalizeText(option && option.name).toLowerCase() === normalizedRaw.toLowerCase();
  });

  return labelMatch ? normalizeText(labelMatch.id) : null;
}

function buildMappedCustomFieldBody(mapping, rawValue) {
  const fieldType = normalizeText(mapping && mapping.clickup_field_type);
  const typeConfig =
    mapping && mapping.clickup_field_type_config && typeof mapping.clickup_field_type_config === "object"
      ? mapping.clickup_field_type_config
      : {};

  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return null;
  }

  if (["short_text", "text", "email", "phone", "url"].includes(fieldType)) {
    const normalized = normalizeText(rawValue);
    return normalized ? { value: normalized } : null;
  }

  if (["number", "currency"].includes(fieldType)) {
    const parsed = parseNumberValue(rawValue);
    return parsed === null ? null : { value: parsed };
  }

  if (fieldType === "checkbox") {
    const parsed = normalizeBooleanValue(rawValue);
    return parsed === null ? null : { value: parsed };
  }

  if (fieldType === "date") {
    const parsed = parseDateValue(rawValue);
    return parsed === null
      ? null
      : {
          value: parsed,
          value_options: {
            time: false,
          },
        };
  }

  if (fieldType === "drop_down") {
    const optionId = findOptionId(typeConfig.options, rawValue);
    return optionId ? { value: optionId } : null;
  }

  if (fieldType === "labels") {
    const items = Array.isArray(rawValue)
      ? rawValue
      : String(rawValue || "")
          .split(/[\n,]+/)
          .map((item) => item.trim())
          .filter(Boolean);
    const optionIds = items
      .map((item) => findOptionId(typeConfig.options, item))
      .filter(Boolean);
    return optionIds.length ? { value: optionIds } : null;
  }

  return null;
}

async function applyMappedCustomFieldsToTask(taskId, fieldMappings, ticketCustomFields) {
  const mappings = normalizeFieldMappings(fieldMappings);
  const customFields = normalizeTicketCustomFields(ticketCustomFields);

  if (!taskId || !mappings.length || !Object.keys(customFields).length) {
    return [];
  }

  const errors = [];

  for (let index = 0; index < mappings.length; index += 1) {
    const mapping = mappings[index];
    const rawValue = getMappedFreshdeskFieldValue(mapping, customFields);
    const requestBody = buildMappedCustomFieldBody(mapping, rawValue);

    if (!requestBody) {
      continue;
    }

    try {
      ensureSuccess(
        await invokeTemplate(
          "clickup_set_field",
          {
            task_id: normalizeText(taskId),
            field_id: mapping.clickup_field_id,
          },
          requestBody
        ),
        "Could not set ClickUp custom field."
      );
    } catch (error) {
      errors.push(
        `${mapping.freshdesk_field_key} -> ${mapping.clickup_field_id}: ${extractErrorMessage(
          error,
          "Custom field sync failed."
        )}`
      );
    }
  }

  return errors;
}

function isPrivateConversation(conversation) {
  return Boolean(
    conversation &&
      (conversation._private ||
        conversation.private ||
        conversation.private_note ||
        conversation.is_private ||
        normalizeText(conversation.kind).toLowerCase() === "private_note")
  );
}

function isCustomerReplyActor(actor) {
  if (!actor || typeof actor !== "object") {
    return false;
  }

  if (actor.helpdesk_agent === true || actor.is_agent === true) {
    return false;
  }

  const actorType = normalizeText(actor.type || actor.role || actor.user_type).toLowerCase();
  if (["agent", "support_agent", "admin"].includes(actorType)) {
    return false;
  }

  if (actor.helpdesk_agent === false) {
    return true;
  }

  if (
    actor.contact_id ||
    actor.requester_id ||
    actor.requestor_id ||
    actor.customer_id ||
    actor.end_user_id
  ) {
    return true;
  }

  return ["requester", "requestor", "contact", "end_user", "customer", "user"].includes(actorType);
}

function isCustomerReplyConversation(payload) {
  const conversation = normalizeEventConversation(payload);
  const actor = (payload && payload.data && payload.data.actor) || {};

  if (isPrivateConversation(conversation)) {
    return false;
  }

  return isCustomerReplyActor(actor);
}

function isAgentReplyConversation(payload) {
  const conversation = normalizeEventConversation(payload);
  const actor = (payload && payload.data && payload.data.actor) || {};

  if (isPrivateConversation(conversation)) {
    return false;
  }

  return !isCustomerReplyActor(actor);
}

function isPublicNoteConversation(payload) {
  const conversation = normalizeEventConversation(payload);
  if (isPrivateConversation(conversation)) {
    return false;
  }

  const typeMarkers = [
    conversation && conversation.kind,
    conversation && conversation.type,
    conversation && conversation.category,
    conversation && conversation.conversation_type,
    conversation && conversation.conversationType,
    conversation && conversation.source_name,
    conversation && conversation.via,
  ]
    .map((value) => normalizeText(value).toLowerCase())
    .filter(Boolean);

  if (
    normalizeBoolean(conversation && conversation.public_note, false) ||
    normalizeBoolean(conversation && conversation.is_public_note, false) ||
    normalizeBoolean(conversation && conversation.note, false)
  ) {
    return true;
  }

  return typeMarkers.some((value) => value.includes("public_note") || value === "note" || value.includes("note"));
}

function isForwardConversation(payload) {
  const conversation = normalizeEventConversation(payload);

  const markers = [
    conversation && conversation.kind,
    conversation && conversation.type,
    conversation && conversation.category,
    conversation && conversation.conversation_type,
    conversation && conversation.conversationType,
    conversation && conversation.source_name,
    conversation && conversation.via,
    conversation && conversation.channel,
    conversation && conversation.sub_type,
  ]
    .map((value) => normalizeText(value).toLowerCase())
    .filter(Boolean);

  if (
    normalizeBoolean(conversation && conversation.forwarded, false) ||
    normalizeBoolean(conversation && conversation.is_forwarded, false)
  ) {
    return true;
  }

  return markers.some((value) => value.includes("forward"));
}

function buildConversationText(conversation) {
  const fullText = conversation && conversation.full_text;
  const bodyText =
    normalizeText(
      conversation &&
        (
          conversation.body_text ||
          conversation.bodyText ||
          conversation.plain_text ||
          (Array.isArray(fullText) ? fullText[0] : fullText)
        )
    ) ||
    stripHtml(conversation && conversation.body) ||
    stripHtml(conversation && (Array.isArray(conversation.body_html) ? conversation.body_html[0] : conversation.body_html));

  return bodyText;
}

function buildPrivateNoteComment(payload) {
  const conversation = normalizeEventConversation(payload);
  const ticket = normalizeEventTicket(payload);
  const actor = (payload && payload.data && payload.data.actor) || {};
  const noteText = buildConversationText(conversation);

  if (!ticket.id || !noteText) {
    return "";
  }

  const actorName =
    normalizeText(actor.name || actor.contact_name || actor.email || actor.username) || "Freshdesk agent";

  return `[Freshdesk Private Note] Ticket #${ticket.id}${ticket.subject ? ` - ${ticket.subject}` : ""}\nBy: ${actorName}\n\n${noteText}`;
}

function buildAgentReplyComment(payload) {
  const conversation = normalizeEventConversation(payload);
  const ticket = normalizeEventTicket(payload);
  const actor = (payload && payload.data && payload.data.actor) || {};
  const replyText = buildConversationText(conversation);

  if (!ticket.id || !replyText) {
    return "";
  }

  const agentName =
    normalizeText(
      actor.name ||
        actor.contact_name ||
        actor.email ||
        actor.username
    ) || "Freshdesk agent";
  const agentEmail = normalizeText(actor.email);
  const byLine = agentEmail && agentEmail !== agentName ? `${agentName} <${agentEmail}>` : agentName;

  return `[Freshdesk Agent Reply] Ticket #${ticket.id}${ticket.subject ? ` - ${ticket.subject}` : ""}\nBy: ${byLine}\n\n${replyText}`;
}

function buildPublicNoteComment(payload) {
  const conversation = normalizeEventConversation(payload);
  const ticket = normalizeEventTicket(payload);
  const actor = (payload && payload.data && payload.data.actor) || {};
  const noteText = buildConversationText(conversation);

  if (!ticket.id || !noteText) {
    return "";
  }

  const actorName =
    normalizeText(
      actor.name ||
        actor.contact_name ||
        actor.email ||
        actor.username
    ) || "Freshdesk agent";
  const actorEmail = normalizeText(actor.email);
  const byLine = actorEmail && actorEmail !== actorName ? `${actorName} <${actorEmail}>` : actorName;

  return `[Freshdesk Public Note] Ticket #${ticket.id}${ticket.subject ? ` - ${ticket.subject}` : ""}\nBy: ${byLine}\n\n${noteText}`;
}

async function syncStoredTasksWithTicket(ticketId, ticket, fieldMappings) {
  const stored = await readTicketLinks(ticketId);
  if (!stored.tasks.length) {
    return [];
  }

  const updatePayload = buildTicketSyncPayload(ticket);
  if (!Object.keys(updatePayload).length) {
    return stored.tasks;
  }

  const syncTimestamp = new Date().toISOString();
  const nextTasks = [];

  for (let index = 0; index < stored.tasks.length; index += 1) {
    const task = stored.tasks[index];

    try {
      ensureSuccess(
        await invokeTemplate(
          "clickup_update",
          {
            task_id: normalizeText(task.task_id),
          },
          updatePayload
        ),
        "Could not sync ClickUp task."
      );

      const customFieldErrors = await applyMappedCustomFieldsToTask(
        task.task_id,
        fieldMappings,
        ticket && ticket.custom_fields
      );

      const syncedTask = applySyncedTicketDetails(task, ticket, syncTimestamp);
      nextTasks.push({
        ...syncedTask,
        last_sync_error: customFieldErrors.join("; "),
      });
    } catch (error) {
      nextTasks.push({
        ...task,
        last_synced_at: syncTimestamp,
        last_sync_error: extractErrorMessage(error, "Sync failed."),
      });
    }
  }

  await writeTicketLinks(ticketId, nextTasks);
  return nextTasks;
}

async function syncStoredCardsWithTicket(ticketId, ticket) {
  const stored = await readTicketLinks(ticketId);
  if (!stored.tasks.length) {
    return [];
  }

  const updatePayload = buildTrelloCardPayloadFromTicket(ticket);
  if (!Object.keys(updatePayload).length) {
    return stored.tasks;
  }

  const syncTimestamp = new Date().toISOString();
  const nextTasks = [];
  const trelloApiKey = resolveTrelloApiKey(ticket && ticket.trello_api_key);

  for (let index = 0; index < stored.tasks.length; index += 1) {
    const task = stored.tasks[index];

    try {
      await writeSuppression(TRELLO_CARD_SUPPRESS_PREFIX, task.task_id, SYNC_SUPPRESS_WINDOW_MS, {
        source: "freshdesk_ticket_sync",
      });
      ensureSuccess(
        await invokeTemplate(
          "trello_card_update",
          await buildTrelloRequestContext({
            card_id: normalizeText(task.task_id),
          }, trelloApiKey),
          updatePayload
        ),
        "Could not sync Trello card."
      );

      nextTasks.push(applySyncedTicketDetailsToCard(task, ticket, syncTimestamp));
    } catch (error) {
      nextTasks.push({
        ...task,
        last_synced_at: syncTimestamp,
        last_sync_error: extractErrorMessage(error, "Sync failed."),
      });
    }
  }

  await writeTicketLinks(ticketId, nextTasks);
  return nextTasks;
}

async function createFreshdeskNoteFromIparam(ticketId, bodyHtml, isPrivate) {
  const noteBody = normalizeText(bodyHtml);
  const normalizedTicketId = normalizeText(ticketId);

  if (!normalizedTicketId || !noteBody) {
    return;
  }

  ensureSuccess(
    await invokeTemplate(
      "freshdesk_note_create",
      {
        ticket_id: normalizedTicketId,
      },
      {
        body: noteBody,
        private: Boolean(isPrivate),
      }
    ),
    "Could not add the Freshdesk note."
  );
}

async function createTrelloCardComment(cardId, commentText, trelloApiKey) {
  const normalizedCardId = normalizeText(cardId);
  const normalizedComment = normalizeText(commentText);

  if (!normalizedCardId || !normalizedComment) {
    return;
  }

  ensureSuccess(
    await invokeTemplate(
      "trello_card_comment",
      await buildTrelloRequestContext({
        card_id: normalizedCardId,
      }, trelloApiKey),
      {
        text: normalizedComment,
      }
    ),
    "Could not add the Trello comment."
  );
}

async function addMemberToTrelloCard(cardId, memberId, trelloApiKey) {
  ensureSuccess(
    await invokeTemplate(
      "trello_card_member_add",
      await buildTrelloRequestContext(
        {
          card_id: normalizeText(cardId),
          value: normalizeText(memberId),
        },
        trelloApiKey
      )
    ),
    "Could not assign the Trello member."
  );
}

async function addLabelToTrelloCard(cardId, labelId, trelloApiKey) {
  ensureSuccess(
    await invokeTemplate(
      "trello_card_label_add",
      await buildTrelloRequestContext(
        {
          card_id: normalizeText(cardId),
          value: normalizeText(labelId),
        },
        trelloApiKey
      )
    ),
    "Could not add the Trello label."
  );
}

async function applySelectionsToTrelloCard(cardId, memberIds, labelIds, trelloApiKey) {
  const errors = [];
  const normalizedCardId = normalizeText(cardId);

  for (let index = 0; index < memberIds.length; index += 1) {
    try {
      await addMemberToTrelloCard(normalizedCardId, memberIds[index], trelloApiKey);
    } catch (error) {
      errors.push(`member ${normalizeText(memberIds[index])}: ${extractErrorMessage(error, "Member assignment failed.")}`);
    }
  }

  for (let index = 0; index < labelIds.length; index += 1) {
    try {
      await addLabelToTrelloCard(normalizedCardId, labelIds[index], trelloApiKey);
    } catch (error) {
      errors.push(`label ${normalizeText(labelIds[index])}: ${extractErrorMessage(error, "Label assignment failed.")}`);
    }
  }

  return errors;
}

async function syncCommentToStoredCards(ticketId, commentText, failureMessage, trelloApiKey) {
  const stored = await readTicketLinks(ticketId);
  if (!stored.tasks.length || !commentText) {
    return stored.tasks;
  }

  const syncTimestamp = new Date().toISOString();
  const nextTasks = [];

  for (let index = 0; index < stored.tasks.length; index += 1) {
    const task = stored.tasks[index];

    try {
      await writeSuppression(TRELLO_CARD_SUPPRESS_PREFIX, task.task_id, SYNC_SUPPRESS_WINDOW_MS, {
        source: "freshdesk_to_trello_comment_sync",
      });
      await createTrelloCardComment(task.task_id, commentText, trelloApiKey);
      nextTasks.push({
        ...task,
        last_synced_at: syncTimestamp,
        last_sync_error: "",
      });
    } catch (error) {
      nextTasks.push({
        ...task,
        last_synced_at: syncTimestamp,
        last_sync_error: extractErrorMessage(error, failureMessage),
      });
    }
  }

  await writeTicketLinks(ticketId, nextTasks);
  return nextTasks;
}

function formatDateTime(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }

  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return normalized;
  }

  return parsed.toISOString().replace(".000Z", "Z");
}

function buildTrelloCardAnchor(taskRecord, fallbackName) {
  const cardName = normalizeText(taskRecord && taskRecord.task_name) || normalizeText(fallbackName) || "linked Trello card";
  const cardUrl = normalizeText(taskRecord && taskRecord.task_url);

  if (!cardUrl) {
    return escapeHtml(cardName);
  }

  return `<a href="${escapeHtml(cardUrl)}" target="_blank" rel="noreferrer">${escapeHtml(cardName)}</a>`;
}

function buildTrelloTicketLinkedNoteBody(ticket, taskRecord) {
  const ticketId = normalizeText(ticket && ticket.id);
  const subject = normalizeText(ticket && ticket.subject);
  const location = [taskRecord && taskRecord.workspace_name, taskRecord && taskRecord.list_name]
    .map(normalizeText)
    .filter(Boolean)
    .join(" / ");

  return [
    `<p><strong>🔗 Trello link ready</strong></p>`,
    `<p>${buildTrelloCardAnchor(taskRecord)} is now connected to ticket #${escapeHtml(ticketId || "unknown")}${subject ? ` - ${escapeHtml(subject)}` : ""}.</p>`,
    location ? `<p>Saved under ${escapeHtml(location)}.</p>` : "",
  ]
    .filter(Boolean)
    .join("");
}

function buildForwardComment(payload) {
  const conversation = normalizeEventConversation(payload);
  const ticket = normalizeEventTicket(payload);
  const actor = (payload && payload.data && payload.data.actor) || {};
  const forwardText = buildConversationText(conversation);

  if (!ticket.id || !forwardText) {
    return "";
  }

  const actorName =
    normalizeText(
      actor.name ||
        actor.contact_name ||
        actor.email ||
        actor.username
    ) || "Freshdesk agent";
  const actorEmail = normalizeText(actor.email);
  const byLine = actorEmail && actorEmail !== actorName ? `${actorName} <${actorEmail}>` : actorName;

  return `[Freshdesk Forward] Ticket #${ticket.id}${ticket.subject ? ` - ${ticket.subject}` : ""}\nBy: ${byLine}\n\n${forwardText}`;
}

function buildFreshdeskTicketLinkedComment(ticket) {
  const ticketId = normalizeText(ticket && ticket.id);
  const subject = normalizeText(ticket && ticket.subject);
  const description = normalizeText(ticket && ticket.description_text);

  return [
    `[Freshdesk Link] Ticket #${ticketId || "unknown"}${subject ? ` - ${subject}` : ""} is now connected to this card.`,
    description ? `Ticket summary:\n${description}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function getTrelloWebhookAction(payload) {
  const external = extractExternalPayload(payload);
  return external && external.action && typeof external.action === "object" ? external.action : null;
}

function isTrelloWebhookPayload(payload) {
  const action = getTrelloWebhookAction(payload);
  const external = extractExternalPayload(payload);
  return Boolean(action && external && external.webhook);
}

function getTrelloWebhookCardId(payload) {
  const action = getTrelloWebhookAction(payload) || {};
  const external = extractExternalPayload(payload);
  const data = action && action.data ? action.data : {};
  const model = external && external.model ? external.model : {};

  const candidates = [
    data && data.card && data.card.id,
    model && model.id,
    data && data.cardSource && data.cardSource.id,
  ];

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = normalizeText(candidates[index]);
    if (candidate) {
      return candidate;
    }
  }

  return "";
}

function getTrelloWebhookTimestamp(payload) {
  const action = getTrelloWebhookAction(payload) || {};
  const parsed = new Date(normalizeText(action.date || Date.now()));
  return Number.isNaN(parsed.getTime()) ? Date.now() : parsed.getTime();
}

function getTrelloWebhookEventKey(payload) {
  const action = getTrelloWebhookAction(payload) || {};
  const external = extractExternalPayload(payload);
  const data = action && action.data ? action.data : {};
  const old = data && data.old ? data.old : {};
  const model = external && external.model ? external.model : {};
  const type = normalizeText(action.type);
  const nextClosedValue =
    data && data.card && Object.prototype.hasOwnProperty.call(data.card, "closed")
      ? data.card.closed
      : model && Object.prototype.hasOwnProperty.call(model, "closed")
      ? model.closed
      : undefined;
  const nextClosed = nextClosedValue === undefined ? false : normalizeBoolean(nextClosedValue, false);

  if (type === "commentCard") {
    return "card_comment_added";
  }

  if (type === "addMemberToCard") {
    return "card_member_added";
  }

  if (type === "addAttachmentToCard") {
    return "card_attachment_added";
  }

  if (type === "addLabelToCard" || type === "removeLabelFromCard") {
    return "card_labels_updated";
  }

  if (type === "moveCardToBoard" || type === "moveCardFromBoard") {
    return "card_moved";
  }

  if (type === "updateCard") {
    if (Object.prototype.hasOwnProperty.call(old, "closed") && nextClosed) {
      return "card_archived";
    }

    if (
      Object.prototype.hasOwnProperty.call(old, "idList") ||
      data.listBefore ||
      data.listAfter
    ) {
      return "card_moved";
    }

    if (
      Object.prototype.hasOwnProperty.call(old, "due") ||
      Object.prototype.hasOwnProperty.call(old, "dueComplete")
    ) {
      return "card_due_date_updated";
    }

    if (Object.prototype.hasOwnProperty.call(old, "idLabels")) {
      return "card_labels_updated";
    }
  }

  return "";
}

function buildTrelloWebhookNoteBody(eventKey, payload, taskRecord) {
  const action = getTrelloWebhookAction(payload) || {};
  const data = action && action.data ? action.data : {};
  const memberCreator = action && action.memberCreator ? action.memberCreator : {};
  const actorName =
    normalizeText(memberCreator.fullName || memberCreator.username || memberCreator.name) || "Trello user";
  const cardLabel = buildTrelloCardAnchor(taskRecord, data && data.card && data.card.name);

  switch (eventKey) {
    case "card_moved": {
      const fromList = normalizeText(data && data.listBefore && data.listBefore.name);
      const toList =
        normalizeText(data && data.listAfter && data.listAfter.name) ||
        normalizeText(data && data.list && data.list.name) ||
        normalizeText(taskRecord && taskRecord.list_name);

      const moveDetail = fromList && toList
        ? `<br /><strong style="color:#c0392b;">${escapeHtml(fromList)}</strong> &rarr; <strong style="color:#27ae60;">${escapeHtml(toList)}</strong>`
        : toList
        ? ` to <strong style="color:#27ae60;">${escapeHtml(toList)}</strong>`
        : fromList
        ? ` from <strong style="color:#c0392b;">${escapeHtml(fromList)}</strong>`
        : "";

      return [
        `<p><strong>🚀 Trello card moved</strong></p>`,
        `<p>${cardLabel} was moved by <strong style="color:#2980b9;">${escapeHtml(actorName)}</strong>${moveDetail}.</p>`,
      ].join("");
    }
    case "card_comment_added": {
      const commentText = escapeHtml(normalizeText(data && data.text)).replace(/\n/g, "<br />");
      return [
        `<p><strong>💬 New Trello comment</strong> on ${cardLabel}</p>`,
        `<p>Added by <strong style="color:#2980b9;">${escapeHtml(actorName)}</strong>.</p>`,
        commentText ? `<p style="border-left:3px solid #3498db; padding-left:8px; color:#555;">${commentText}</p>` : "",
      ]
        .filter(Boolean)
        .join("");
    }
    case "card_member_added": {
      const addedMember =
        normalizeText(
          (action && action.member && (action.member.fullName || action.member.username || action.member.name)) ||
            (data && data.member && (data.member.fullName || data.member.username || data.member.name))
        ) || "a Trello member";

      return [
        `<p><strong>👤 Trello member update</strong></p>`,
        `<p><strong style="color:#27ae60;">${escapeHtml(addedMember)}</strong> was added to ${cardLabel} by <strong style="color:#2980b9;">${escapeHtml(actorName)}</strong>.</p>`,
      ].join("");
    }
    case "card_labels_updated": {
      const labelName =
        normalizeText(data && data.label && (data.label.name || data.label.color)) ||
        normalizeText(data && data.text);

      return [
        `<p><strong>🏷️ Trello labels changed</strong></p>`,
        `<p>${cardLabel} had its labels updated by <strong style="color:#2980b9;">${escapeHtml(actorName)}</strong>${labelName ? ` (<strong style="color:#8e44ad;">${escapeHtml(labelName)}</strong>)` : ""}.</p>`,
      ].join("");
    }
    case "card_due_date_updated": {
      const oldDueRaw = data && data.old && Object.prototype.hasOwnProperty.call(data.old, "due") ? data.old.due : undefined;
      const oldDue = oldDueRaw !== undefined ? (formatDateTime(oldDueRaw) || "No due date") : null;
      const newDue =
        formatDateTime(data && data.card && data.card.due) ||
        formatDateTime(taskRecord && taskRecord.due_date) ||
        "No due date";

      const dueLine = oldDue !== null
        ? `<strong style="color:#c0392b;">${escapeHtml(oldDue)}</strong> &rarr; <strong style="color:#27ae60;">${escapeHtml(newDue)}</strong>`
        : `<strong style="color:#27ae60;">${escapeHtml(newDue)}</strong>`;

      return [
        `<p><strong>📅 Trello due date changed</strong></p>`,
        `<p>${cardLabel} was updated by <strong style="color:#2980b9;">${escapeHtml(actorName)}</strong>.</p>`,
        `<p>Due date: ${dueLine}</p>`,
      ].join("");
    }
    case "card_attachment_added": {
      const attachmentName =
        normalizeText(data && data.attachment && (data.attachment.name || data.attachment.url)) || "an attachment";
      return [
        `<p><strong>📎 Trello attachment added</strong></p>`,
        `<p><strong style="color:#2980b9;">${escapeHtml(actorName)}</strong> attached <strong style="color:#16a085;">${escapeHtml(attachmentName)}</strong> to ${cardLabel}.</p>`,
      ].join("");
    }
    case "card_archived":
      return [
        `<p><strong>🗄️ Trello card archived</strong></p>`,
        `<p>${cardLabel} was <strong style="color:#c0392b;">archived</strong> by <strong style="color:#2980b9;">${escapeHtml(actorName)}</strong>.</p>`,
      ].join("");
    default:
      return "";
  }
}

function buildTrelloTaskFromWebhookPayload(taskRecord, payload, syncTimestamp, syncError, eventId) {
  const action = getTrelloWebhookAction(payload) || {};
  const external = extractExternalPayload(payload);
  const data = action && action.data ? action.data : {};
  const model = external && external.model ? external.model : {};
  const meta = buildTrelloTaskMetaFromStoredRecord(taskRecord);

  const nextRecord = normalizeTrelloCardRecord(
    {
      id: normalizeText((data && data.card && data.card.id) || model.id || taskRecord && taskRecord.task_id),
      name: normalizeText((data && data.card && data.card.name) || model.name || taskRecord && taskRecord.task_name),
      url:
        normalizeText(model && model.url) ||
        normalizeText(taskRecord && taskRecord.task_url) ||
        (normalizeText(model && model.shortLink)
          ? `https://trello.com/c/${normalizeText(model.shortLink)}`
          : ""),
      due:
        normalizeText(model && model.due) ||
        normalizeText(data && data.card && data.card.due) ||
        normalizeText(taskRecord && taskRecord.due_date),
      closed:
        typeof (model && model.closed) === "boolean"
          ? model.closed
          : typeof (data && data.card && data.card.closed) === "boolean"
          ? data.card.closed
          : normalizeText(taskRecord && taskRecord.status).toLowerCase() === "archived",
      idList:
        normalizeText((data && data.listAfter && data.listAfter.id) || (data && data.list && data.list.id)) ||
        normalizeText(model && model.idList) ||
        meta.list_id,
      labels: Array.isArray(model && model.labels) ? model.labels : meta.labels,
    },
    {
      ...meta,
      workspace_id: normalizeText((data && data.board && data.board.id) || meta.workspace_id),
      workspace_name: normalizeText((data && data.board && data.board.name) || meta.workspace_name),
      list_id:
        normalizeText((data && data.listAfter && data.listAfter.id) || (data && data.list && data.list.id)) ||
        meta.list_id,
      list_name:
        normalizeText((data && data.listAfter && data.listAfter.name) || (data && data.list && data.list.name)) ||
        meta.list_name,
    }
  ) || taskRecord;

  return {
    ...taskRecord,
    ...nextRecord,
    synced_comment_ids: eventId
      ? normalizeStringList(getStoredTaskCommentIds(taskRecord).concat(normalizeText(eventId)))
      : getStoredTaskCommentIds(taskRecord),
    last_synced_at: syncTimestamp,
    last_sync_error: normalizeText(syncError),
  };
}

async function applyLinkedCardNotifications(ticket, cardRecord, settings) {
  const errors = [];
  const freshdeskAction = getTrelloToFreshdeskNotificationAction(settings, "ticket_linked");
  const trelloAction = getFreshdeskToTrelloNotificationAction(settings, "ticket_linked");
  const trelloApiKey = resolveTrelloApiKey(settings && settings.trello_api_key);

  if (freshdeskAction !== "none") {
    try {
      await writeSuppression(TICKET_SUPPRESS_PREFIX, ticket && ticket.id, SYNC_SUPPRESS_WINDOW_MS, {
        source: "trello_ticket_linked_note",
      });
      await createFreshdeskNoteFromIparam(
        ticket && ticket.id,
        buildTrelloTicketLinkedNoteBody(ticket, cardRecord),
        freshdeskAction === "private_note_notify"
      );
    } catch (error) {
      errors.push(`Freshdesk link note: ${extractErrorMessage(error, "Linked-card note failed.")}`);
    }
  }

  if (trelloAction === "comment") {
    try {
      await createTrelloCardComment(
        cardRecord && cardRecord.task_id,
        buildFreshdeskTicketLinkedComment(ticket),
        trelloApiKey
      );
    } catch (error) {
      errors.push(`Trello link comment: ${extractErrorMessage(error, "Linked-card comment failed.")}`);
    }
  }

  return errors;
}

function getClickupCommentFromEvent(payload) {
  const external = extractExternalPayload(payload);

  if (looksLikeClickupComment(external && external.comment)) {
    return external.comment;
  }

  if (looksLikeClickupComment(external && external.comment_data)) {
    return external.comment_data;
  }

  if (looksLikeClickupComment(external && external.history_item && external.history_item.comment)) {
    return external.history_item.comment;
  }

  const historyItems = Array.isArray(external && external.history_items) ? external.history_items : [];

  for (let index = 0; index < historyItems.length; index += 1) {
    const item = historyItems[index];
    if (looksLikeClickupComment(item && item.comment)) {
      return item.comment;
    }

    if (normalizeText(item && item.field) === "comment" && looksLikeClickupComment(item && item.after)) {
      return item.after;
    }

    if (looksLikeClickupComment(item && item.after && item.after.comment)) {
      return item.after.comment;
    }
  }

  return null;
}

function summarizeClickupExternalPayload(payload) {
  const external = extractExternalPayload(payload);
  const historyItems = Array.isArray(external && external.history_items) ? external.history_items : [];

  return {
    top_level_keys: Object.keys(external || {}).slice(0, 20),
    history_count: historyItems.length,
    history_fields: historyItems
      .slice(0, 5)
      .map((item) => normalizeText(item && item.field))
      .filter(Boolean),
    has_comment: looksLikeClickupComment(external && external.comment),
    has_comment_data: looksLikeClickupComment(external && external.comment_data),
    has_history_item_comment: looksLikeClickupComment(external && external.history_item && external.history_item.comment),
  };
}

async function createFreshdeskNote(domain, encodedAuth, ticketId, bodyHtml, isPrivate) {
  const noteBody = normalizeText(bodyHtml);
  if (!noteBody) {
    return;
  }

  ensureSuccess(
    await invokeTemplate(
      "freshdesk_note_create_live",
      {
        domain,
        encoded_auth: encodedAuth,
        ticket_id: ticketId,
      },
      {
        body: noteBody,
        private: Boolean(isPrivate),
      }
    ),
    "Could not add the Freshdesk note."
  );
}

async function syncClickupTaskToFreshdeskTickets(taskId, settings, payload) {
  const normalizedTaskId = normalizeText(taskId);
  const taskLinks = await readTaskLinks(normalizedTaskId);

  if (!taskLinks.ticket_ids.length) {
    console.log(`[ClickUp->Freshdesk] No linked tickets found for task ${normalizedTaskId}.`);
    return [];
  }

  const clickupToken = normalizeText(settings && settings.clickup_api_token);
  const freshdesk = getFreshdeskContextFromSettings(settings);

  if (!clickupToken || !freshdesk.domain || !freshdesk.encoded_auth) {
    throw new Error("Reverse sync settings are incomplete.");
  }

  const commentSyncMode = resolveClickupCommentSyncMode(settings);
  if (commentSyncMode === "none") {
    console.log(`[ClickUp->Freshdesk] Ignoring task ${normalizedTaskId} because ClickUp comment sync is disabled in settings.`);
    return [];
  }

  const taskPayload = ensureSuccess(
    await invokeTemplate("clickup_task_live", {
      clickup_token: clickupToken,
      task_id: normalizedTaskId,
    }),
    "Could not load the updated ClickUp task."
  );

  const syncTimestamp = new Date().toISOString();
  const eventComment = getClickupCommentFromEvent(payload);
  const results = [];

  if (!eventComment) {
    console.log(`[ClickUp->Freshdesk] Event for task ${normalizedTaskId} did not include a comment payload.`);
    return results;
  }

  if (isFreshdeskMirroredClickupComment(eventComment)) {
    console.log(
      `[ClickUp->Freshdesk] Ignoring comment ${normalizeText(eventComment.id)} for task ${normalizedTaskId} because it was mirrored from Freshdesk.`
    );
    return results;
  }

  console.log(
    `[ClickUp->Freshdesk] Processing comment ${normalizeText(eventComment.id)} for task ${normalizedTaskId} across ${taskLinks.ticket_ids.length} linked ticket(s).`
  );

  for (let index = 0; index < taskLinks.ticket_ids.length; index += 1) {
    const ticketId = normalizeText(taskLinks.ticket_ids[index]);
    const stored = await readTicketLinks(ticketId);

    if (!stored.tasks.length) {
      console.log(`[ClickUp->Freshdesk] Ticket ${ticketId} no longer has stored task links. Skipping.`);
      continue;
    }

    try {
      const storedTask = getStoredTaskRecord(stored.tasks, normalizedTaskId);
      const storedCommentIds = getStoredTaskCommentIds(storedTask);
      const syncErrors = [];

      if (eventComment && !storedCommentIds.includes(normalizeText(eventComment.id))) {
        try {
          await writeSuppression(TICKET_SUPPRESS_PREFIX, ticketId, SYNC_SUPPRESS_WINDOW_MS, {
            source: "clickup_comment_reverse_sync",
          });
          await createFreshdeskNote(
            freshdesk.domain,
            freshdesk.encoded_auth,
            ticketId,
            buildClickupCommentNoteBody(taskPayload, eventComment),
            commentSyncMode === "private"
          );
          console.log(
            `[ClickUp->Freshdesk] Created Freshdesk private note for ticket ${ticketId} from ClickUp comment ${normalizeText(eventComment.id)}.`
          );
        } catch (error) {
          syncErrors.push(`comment note: ${extractErrorMessage(error, "Reverse comment sync failed.")}`);
          console.error(
            `[ClickUp->Freshdesk] Failed to create Freshdesk note for ticket ${ticketId} from comment ${normalizeText(eventComment.id)}:`,
            error
          );
        }
      } else {
        console.log(
          `[ClickUp->Freshdesk] Comment ${normalizeText(eventComment.id)} was already synced for ticket ${ticketId}.`
        );
      }

      const nextTasks = stored.tasks.map((task) => {
        if (normalizeText(task && task.task_id) !== normalizedTaskId) {
          return task;
        }

        const refreshedTask = normalizeTaskRecord(taskPayload, buildTaskMetaFromStoredRecord(task));
        return {
          ...task,
          ...refreshedTask,
          synced_comment_ids: eventComment
            ? normalizeStringList(storedCommentIds.concat(normalizeText(eventComment.id)))
            : storedCommentIds,
          last_synced_at: syncTimestamp,
          last_sync_error: syncErrors.join("; "),
        };
      });

      await writeTicketLinks(ticketId, nextTasks);
      results.push({
        ticket_id: ticketId,
        success: syncErrors.length === 0,
        message: syncErrors.join("; "),
      });
      if (!syncErrors.length) {
        console.log(`[ClickUp->Freshdesk] Reverse comment sync completed for ticket ${ticketId}.`);
      }
    } catch (error) {
      const nextTasks = stored.tasks.map((task) => {
        if (normalizeText(task && task.task_id) !== normalizedTaskId) {
          return task;
        }

        return {
          ...task,
          last_synced_at: syncTimestamp,
          last_sync_error: extractErrorMessage(error, "Reverse sync failed."),
        };
      });

      await writeTicketLinks(ticketId, nextTasks);
      results.push({
        ticket_id: ticketId,
        success: false,
        message: extractErrorMessage(error, "Reverse sync failed."),
      });
      console.error(
        `[ClickUp->Freshdesk] Reverse sync failed for task ${normalizedTaskId} and ticket ${ticketId}:`,
        error
      );
    }
  }

  return results;
}

async function syncTrelloCardToFreshdeskTickets(cardId, settings, payload) {
  const normalizedCardId = normalizeText(cardId);
  const ticketLinks = await readTaskLinks(normalizedCardId);

  if (!ticketLinks.ticket_ids.length) {
    console.log(`[Trello->Freshdesk] No linked tickets found for card ${normalizedCardId}.`);
    return [];
  }

  const eventKey = getTrelloWebhookEventKey(payload);
  if (!eventKey) {
    console.log(`[Trello->Freshdesk] Ignoring unsupported Trello webhook for card ${normalizedCardId}.`);
    return [];
  }

  const syncMode = getTrelloToFreshdeskNotificationAction(settings, eventKey);
  if (syncMode === "none") {
    console.log(`[Trello->Freshdesk] Ignoring ${eventKey} for card ${normalizedCardId} because the setting is disabled.`);
    return [];
  }

  if (await isSuppressed(TRELLO_CARD_SUPPRESS_PREFIX, normalizedCardId, getTrelloWebhookTimestamp(payload))) {
    console.log(`[Trello->Freshdesk] Ignoring suppressed webhook for card ${normalizedCardId}.`);
    return [];
  }

  const action = getTrelloWebhookAction(payload) || {};
  const eventId = normalizeText(action.id);
  const syncTimestamp = new Date().toISOString();
  const results = [];

  for (let index = 0; index < ticketLinks.ticket_ids.length; index += 1) {
    const ticketId = normalizeText(ticketLinks.ticket_ids[index]);
    const stored = await readTicketLinks(ticketId);
    const storedTask = getStoredTaskRecord(stored.tasks, normalizedCardId);

    if (!storedTask) {
      continue;
    }

    const syncedCommentIds = getStoredTaskCommentIds(storedTask);
    const isDuplicateComment = eventKey === "card_comment_added" && eventId && syncedCommentIds.includes(eventId);
    const syncErrors = [];

    if (!isDuplicateComment) {
      try {
        const noteBody = buildTrelloWebhookNoteBody(eventKey, payload, storedTask);
        if (noteBody) {
          await writeSuppression(TICKET_SUPPRESS_PREFIX, ticketId, SYNC_SUPPRESS_WINDOW_MS, {
            source: "trello_webhook_reverse_sync",
          });
          await createFreshdeskNoteFromIparam(ticketId, noteBody, syncMode === "private_note_notify");
        }
      } catch (error) {
        syncErrors.push(extractErrorMessage(error, "Reverse Trello sync failed."));
      }
    }

    const nextTasks = stored.tasks.map((task) => {
      if (normalizeText(task && task.task_id) !== normalizedCardId) {
        return task;
      }

      return buildTrelloTaskFromWebhookPayload(task, payload, syncTimestamp, syncErrors.join("; "), eventId);
    });

    await writeTicketLinks(ticketId, nextTasks);
    results.push({
      ticket_id: ticketId,
      success: syncErrors.length === 0,
      message: syncErrors.join("; "),
    });
  }

  return results;
}

exports = {
  async onAppInstall(payload) {
    try {
      const settings = resolveSettings(payload);
      await writeTrelloRuntimeSettings(settings);
      const targetUrl = await generateTargetUrl();
      const existing = await readTrelloWebhookStore();
      await writeTrelloWebhookStore(targetUrl, existing.registrations || []);
      return renderData();
    } catch (error) {
      return renderData({
        message: extractErrorMessage(error, "Trello webhook setup failed.").slice(0, 60),
      });
    }
  },

  async afterAppUpdate(payload) {
    try {
      const settings = resolveSettings(payload);
      await writeTrelloRuntimeSettings(settings);
      const targetUrl = await generateTargetUrl();
      const previous = await readTrelloWebhookStore();
      const trelloApiKey = resolveTrelloApiKey(settings && settings.trello_api_key);

      if (normalizeText(previous.target_url) !== normalizeText(targetUrl) && previous.registrations.length) {
        await cleanupRegisteredTrelloWebhooks(previous.registrations, trelloApiKey);

        const registrations = [];
        for (let index = 0; index < previous.registrations.length; index += 1) {
          const registration = previous.registrations[index];
          const cardId = normalizeText(registration && registration.card_id);
          if (!cardId) {
            continue;
          }

          const storedTicketLinks = await readTaskLinks(cardId);
          if (!storedTicketLinks.ticket_ids.length) {
            continue;
          }

          const firstTicketLinks = await readTicketLinks(storedTicketLinks.ticket_ids[0]);
          const cardRecord = getStoredTaskRecord(firstTicketLinks.tasks, cardId);

          if (!cardRecord) {
            continue;
          }

          registrations.push(await registerTrelloWebhook(cardRecord, targetUrl, trelloApiKey));
        }

        await writeTrelloWebhookStore(targetUrl, registrations);
      } else {
        await writeTrelloWebhookStore(targetUrl, previous.registrations || []);
      }

      return renderData();
    } catch (error) {
      return renderData({
        message: extractErrorMessage(error, "Trello webhook update failed.").slice(0, 60),
      });
    }
  },

  async onAppUninstall() {
    try {
      const previous = await readTrelloWebhookStore();
      await cleanupRegisteredTrelloWebhooks(previous.registrations, resolveTrelloApiKey());
      await clearTrelloWebhookStore();
      await clearTrelloRuntimeSettings();
      return renderData();
    } catch {
      return renderData();
    }
  },

  async onExternalEvent(payload) {
    try {
      if (isTrelloWebhookPayload(payload)) {
        const settings = resolveSettings(payload);
        const cardId = getTrelloWebhookCardId(payload);
        const eventKey = getTrelloWebhookEventKey(payload);

        console.log(
          `[Trello->Freshdesk] Received Trello webhook ${eventKey || "unknown"} for card ${cardId || "unknown"}.`
        );

        if (!cardId || !eventKey) {
          return;
        }

        await syncTrelloCardToFreshdeskTickets(cardId, settings, payload);
        return;
      }

      const settings = resolveSettings(payload);
      const eventName = getClickupEventName(payload);
      const taskId = getClickupEventTaskId(payload);
      const payloadSummary = summarizeClickupExternalPayload(payload);

      console.log(
        `[ClickUp->Freshdesk] Received external event ${eventName || "unknown"} for task ${taskId || "unknown"}.`
      );
      console.log("[ClickUp->Freshdesk] Event payload summary:", payloadSummary);

      if (!isSupportedClickupReverseEvent(eventName) || !taskId) {
        console.log(
          `[ClickUp->Freshdesk] Ignoring external event ${eventName || "unknown"} because it is not a supported comment event or task_id is missing.`
        );
        return;
      }

      await syncClickupTaskToFreshdeskTickets(taskId, settings, payload);
    } catch (error) {
      console.error("Reverse sync from external provider failed:", error);
    }
  },

  async getDashboardData() {
    try {
      const summary = await readDashboardSummary();
      const linked_tickets = sortDashboardTickets(await readDashboardTickets());

      return buildSuccess({
        summary,
        linked_tickets,
      });
    } catch (error) {
      return buildFailure("Unable to load connector dashboard data.", error);
    }
  },

  async handleTicketUpdate(payload) {
    try {
      if (!isAutomaticSyncEnabled(payload)) {
        return;
      }

      const ticket = normalizeEventTicket(payload);
      if (!ticket.id) {
        return;
      }

      if (await isSuppressed(TICKET_SUPPRESS_PREFIX, ticket.id, Date.now())) {
        return;
      }

      await syncStoredCardsWithTicket(
        ticket.id,
        {
          ...ticket,
        }
      );
    } catch (error) {
      console.error("Automatic Trello sync failed on ticket update:", error);
    }
  },

  async handleConversationCreate(payload) {
    try {
      const settings = getEventIparams(payload);
      const conversation = normalizeEventConversation(payload);
      const ticket = normalizeEventTicket(payload);
      if (ticket.id && (await isSuppressed(TICKET_SUPPRESS_PREFIX, ticket.id, Date.now()))) {
        return;
      }

      if (!ticket.id) {
        return;
      }

      if (isPrivateConversation(conversation)) {
        if (getFreshdeskToTrelloNotificationAction(settings, "private_note_added") !== "comment") {
          return;
        }

        const privateNoteComment = buildPrivateNoteComment(payload);
        if (!privateNoteComment) {
          return;
        }

        await syncCommentToStoredCards(ticket.id, privateNoteComment, "Private note sync failed.");
        return;
      }

      if (isForwardConversation(payload)) {
        if (getFreshdeskToTrelloNotificationAction(settings, "ticket_forwarded") !== "comment") {
          return;
        }

        const forwardComment = buildForwardComment(payload);
        if (!forwardComment) {
          return;
        }

        await syncCommentToStoredCards(ticket.id, forwardComment, "Ticket forward sync failed.");
        return;
      }

      if (isPublicNoteConversation(payload)) {
        if (getFreshdeskToTrelloNotificationAction(settings, "public_note_added") !== "comment") {
          return;
        }

        const publicNoteComment = buildPublicNoteComment(payload);
        if (!publicNoteComment) {
          return;
        }

        await syncCommentToStoredCards(ticket.id, publicNoteComment, "Public note sync failed.");
        return;
      }

      if (isCustomerReplyConversation(payload)) {
        return;
      }

      if (!isAgentReplyConversation(payload)) {
        return;
      }

      if (getFreshdeskToTrelloNotificationAction(settings, "agent_reply_added") !== "comment") {
        return;
      }

      const agentReplyComment = buildAgentReplyComment(payload);
      if (!agentReplyComment) {
        return;
      }

      await syncCommentToStoredCards(ticket.id, agentReplyComment, "Agent reply sync failed.");
    } catch (error) {
      console.error("Conversation sync to Trello failed:", error);
    }
  },

  async getSidebarData(args) {
    try {
      const requestArgs = parseArgs(args);
      const ticketId = normalizeText(requestArgs.ticket_id);

      if (!ticketId) {
        return buildFailure("Ticket ID is required.");
      }

      const stored = await readTicketLinks(ticketId);
      if (stored.tasks.length) {
        await syncReverseTaskLinks(ticketId, [], stored.tasks);
      }
      const summary = await readDashboardSummary();
      if (
        stored.tasks.length &&
        !summary.tracked_ticket_ids.some((trackedId) => normalizeText(trackedId) === ticketId)
      ) {
        await syncDashboardSummary(ticketId, [], stored.tasks);
      }

      return buildSuccess({
        linked_tasks: sortLinkedTasks(stored.tasks),
      });
    } catch (error) {
      return buildFailure("Unable to load linked Trello cards.", error);
    }
  },

  async getTrelloBoards(args) {
    let requestContext = null;
    try {
      const requestArgs = parseArgs(args);
      requestContext = await buildTrelloRequestContext(
        {},
        requestArgs.trello_api_key,
        "",
        requestArgs
      );
      const payload = ensureSuccess(
        await invokeTemplate("trello_boards", requestContext),
        "Could not load Trello boards."
      );
      const boards = (Array.isArray(payload) ? payload : []).map(normalizeTrelloBoard).filter(Boolean);
      return buildSuccess({ boards });
    } catch (error) {
      if (isInvalidTrelloTokenError(error)) {
        console.error("[Trello] Failed to load boards: invalid saved token.", {
          token_fingerprint: normalizeText(requestContext && requestContext.trello_token_fingerprint),
          token_saved_at: normalizeText(requestContext && requestContext.trello_token_saved_at),
        });
        return buildFailure(
          "The saved Trello connection is no longer valid. Reconnect Trello in app settings, then update or reinstall the app.",
          error
        );
      }

      console.error("[Trello] Failed to load boards:", {
        token_fingerprint: normalizeText(requestContext && requestContext.trello_token_fingerprint),
        token_saved_at: normalizeText(requestContext && requestContext.trello_token_saved_at),
        message: extractErrorMessage(error, "Unable to load Trello boards."),
      });
      return buildFailure("Unable to load Trello boards.", error);
    }
  },

  async getTrelloMembers(args) {
    let requestContext = null;
    try {
      const requestArgs = parseArgs(args);
      const boardId = normalizeText(requestArgs.board_id);

      if (!boardId) {
        return buildFailure("Board ID is required.");
      }

      requestContext = await buildTrelloRequestContext(
        {
          board_id: boardId,
        },
        requestArgs.trello_api_key,
        "",
        requestArgs
      );

      const payload = ensureSuccess(
        await invokeTemplate("trello_members", requestContext),
        "Could not load Trello members."
      );
      const members = (Array.isArray(payload) ? payload : []).map(normalizeTrelloMember).filter(Boolean);
      return buildSuccess({ members });
    } catch (error) {
      console.error("[Trello] Failed to load members:", {
        board_id: normalizeText(args && parseArgs(args).board_id),
        token_fingerprint: normalizeText(requestContext && requestContext.trello_token_fingerprint),
        token_saved_at: normalizeText(requestContext && requestContext.trello_token_saved_at),
        message: extractErrorMessage(error, "Unable to load Trello members."),
      });
      return buildFailure("Unable to load Trello members.", error);
    }
  },

  async getTrelloLabels(args) {
    let requestContext = null;
    try {
      const requestArgs = parseArgs(args);
      const boardId = normalizeText(requestArgs.board_id);

      if (!boardId) {
        return buildFailure("Board ID is required.");
      }

      requestContext = await buildTrelloRequestContext(
        {
          board_id: boardId,
        },
        requestArgs.trello_api_key,
        "",
        requestArgs
      );

      const payload = ensureSuccess(
        await invokeTemplate("trello_labels", requestContext),
        "Could not load Trello labels."
      );
      const labels = (Array.isArray(payload) ? payload : []).map(normalizeTrelloLabel).filter(Boolean);
      return buildSuccess({ labels });
    } catch (error) {
      console.error("[Trello] Failed to load labels:", {
        board_id: normalizeText(args && parseArgs(args).board_id),
        token_fingerprint: normalizeText(requestContext && requestContext.trello_token_fingerprint),
        token_saved_at: normalizeText(requestContext && requestContext.trello_token_saved_at),
        message: extractErrorMessage(error, "Unable to load Trello labels."),
      });
      return buildFailure("Unable to load Trello labels.", error);
    }
  },

  async getTrelloLists(args) {
    let requestContext = null;
    try {
      const requestArgs = parseArgs(args);
      const boardId = normalizeText(requestArgs.board_id);

      if (!boardId) {
        return buildFailure("Board ID is required.");
      }

      requestContext = await buildTrelloRequestContext(
        {
          board_id: boardId,
        },
        requestArgs.trello_api_key,
        "",
        requestArgs
      );

      const payload = ensureSuccess(
        await invokeTemplate("trello_lists", requestContext),
        "Could not load Trello lists."
      );
      const lists = (Array.isArray(payload) ? payload : []).map(normalizeTrelloList).filter(Boolean);
      return buildSuccess({ lists });
    } catch (error) {
      if (isInvalidTrelloTokenError(error)) {
        console.error("[Trello] Failed to load lists: invalid saved token.");
        return buildFailure(
          "The saved Trello connection is no longer valid. Reconnect Trello in app settings, then update or reinstall the app.",
          error
        );
      }

      console.error("[Trello] Failed to load lists:", {
        board_id: normalizeText(args && parseArgs(args).board_id),
        token_fingerprint: normalizeText(requestContext && requestContext.trello_token_fingerprint),
        token_saved_at: normalizeText(requestContext && requestContext.trello_token_saved_at),
        message: extractErrorMessage(error, "Unable to load Trello lists."),
      });
      return buildFailure("Unable to load Trello lists.", error);
    }
  },

  async getTrelloCards(args) {
    let requestContext = null;
    try {
      const requestArgs = parseArgs(args);
      const listId = normalizeText(requestArgs.list_id);

      if (!listId) {
        return buildFailure("List ID is required.");
      }

      requestContext = await buildTrelloRequestContext(
        {
          list_id: listId,
        },
        requestArgs.trello_api_key,
        "",
        requestArgs
      );

      const payload = ensureSuccess(
        await invokeTemplate("trello_cards", requestContext),
        "Could not load Trello cards."
      );

      const cards = (Array.isArray(payload) ? payload : [])
        .map((card) =>
          normalizeTrelloCardRecord(card, {
            workspace_id: normalizeText(requestArgs.board_id),
            workspace_name: normalizeText(requestArgs.board_name),
            list_id: listId,
            list_name: normalizeText(requestArgs.list_name),
          })
        )
        .filter(Boolean);

      return buildSuccess({ cards });
    } catch (error) {
      if (isInvalidTrelloTokenError(error)) {
        console.error("[Trello] Failed to load cards: invalid saved token.");
        return buildFailure(
          "The saved Trello connection is no longer valid. Reconnect Trello in app settings, then update or reinstall the app.",
          error
        );
      }

      console.error("[Trello] Failed to load cards:", {
        list_id: normalizeText(args && parseArgs(args).list_id),
        token_fingerprint: normalizeText(requestContext && requestContext.trello_token_fingerprint),
        token_saved_at: normalizeText(requestContext && requestContext.trello_token_saved_at),
        message: extractErrorMessage(error, "Unable to load Trello cards."),
      });
      return buildFailure("Unable to load Trello cards.", error);
    }
  },

  async createTicketCard(args) {
    try {
      const requestArgs = parseArgs(args);
      const ticketId = normalizeText(requestArgs.ticket_id);
      const listId = normalizeText(requestArgs.list_id);
      const title = normalizeText(requestArgs.title);
      const description = normalizeText(requestArgs.description);

      if (!ticketId || !listId || !title || !description) {
        return buildFailure("Ticket ID, card name, description, and list are required.");
      }

      const requestBody = {
        idList: listId,
        name: title,
        desc: description,
      };
      const memberIds = normalizeStringList(requestArgs.member_ids);
      const labelIds = normalizeStringList(requestArgs.label_ids);

      const dueDate = normalizeText(requestArgs.due_date);
      if (dueDate) {
        requestBody.due = `${dueDate}T00:00:00.000Z`;
      }

      const requestContext = await buildTrelloRequestContext(
        {},
        requestArgs.trello_api_key,
        "",
        requestArgs
      );
      const createdCardPayload = ensureSuccess(
        await invokeTemplate(
          "trello_card_create",
          requestContext,
          requestBody
        ),
        "Could not create the Trello card."
      );

      const cardRecord = normalizeTrelloCardRecord(createdCardPayload, {
        workspace_id: normalizeText(requestArgs.board_id),
        workspace_name: normalizeText(requestArgs.board_name),
        list_id: listId,
        list_name: normalizeText(requestArgs.list_name),
        assignees: normalizeAssignees(requestArgs.members),
        labels: (Array.isArray(requestArgs.labels) ? requestArgs.labels : []).map(normalizeTrelloLabel).filter(Boolean),
        source: "created",
        linked_at: new Date().toISOString(),
      });

      const existing = await readTicketLinks(ticketId);
      let nextTasks = upsertLinkedTask(existing.tasks, cardRecord);
      await writeTicketLinks(ticketId, nextTasks);

      const linkedActionErrors = await applyLinkedCardNotifications(requestArgs.ticket || {}, cardRecord, requestArgs);

      const selectionErrors = await applySelectionsToTrelloCard(
        normalizeText(cardRecord && cardRecord.task_id),
        memberIds,
        labelIds,
        requestArgs.trello_api_key
      );
      linkedActionErrors.push(...selectionErrors);

      try {
        await ensureTrelloWebhookRegistration(cardRecord, requestArgs.trello_api_key);
      } catch (error) {
        linkedActionErrors.push(`Trello webhook: ${extractErrorMessage(error, "Webhook setup failed.")}`);
      }

      if (linkedActionErrors.length) {
        nextTasks = nextTasks.map((task) => {
          if (normalizeText(task && task.task_id) !== normalizeText(cardRecord && cardRecord.task_id)) {
            return task;
          }

          return {
            ...task,
            last_synced_at: new Date().toISOString(),
            last_sync_error: linkedActionErrors.join("; "),
          };
        });
        await writeTicketLinks(ticketId, nextTasks);
      }

      return buildSuccess({
        task: cardRecord,
        linked_tasks: nextTasks,
      });
    } catch (error) {
      return buildFailure("Unable to create and link the Trello card.", error);
    }
  },

  async syncLinkedTicketCards(args) {
    try {
      const requestArgs = parseArgs(args);
      const ticketId = normalizeText(requestArgs.ticket_id);
      const ticket = requestArgs.ticket || {};

      if (!ticketId) {
        return buildFailure("Ticket ID is required.");
      }

      if (!Object.keys(buildTrelloCardPayloadFromTicket(ticket)).length) {
        return buildFailure("Ticket details are not available to sync.");
      }

      const nextTasks = await syncStoredCardsWithTicket(ticketId, ticket);

      return buildSuccess({
        linked_tasks: nextTasks,
        synced_at: new Date().toISOString(),
      });
    } catch (error) {
      return buildFailure("Unable to sync linked Trello cards.", error);
    }
  },

  async linkTicketCard(args) {
    try {
      const requestArgs = parseArgs(args);
      const ticketId = normalizeText(requestArgs.ticket_id);

      if (!ticketId || !requestArgs.task) {
        return buildFailure("Ticket ID and card details are required.");
      }

      const cardRecord = sanitizeTrelloCardLinkPayload(requestArgs.task, {
        workspace_id: normalizeText(requestArgs.board_id),
        workspace_name: normalizeText(requestArgs.board_name),
        list_id: normalizeText(requestArgs.list_id),
        list_name: normalizeText(requestArgs.list_name),
        source: "linked",
      });

      if (!cardRecord) {
        return buildFailure("Card details are invalid.");
      }

      const existing = await readTicketLinks(ticketId);
      let nextTasks = upsertLinkedTask(existing.tasks, cardRecord);
      await writeTicketLinks(ticketId, nextTasks);

      const linkedActionErrors = await applyLinkedCardNotifications(requestArgs.ticket || {}, cardRecord, requestArgs);

      try {
        await ensureTrelloWebhookRegistration(cardRecord, requestArgs.trello_api_key);
      } catch (error) {
        linkedActionErrors.push(`Trello webhook: ${extractErrorMessage(error, "Webhook setup failed.")}`);
      }

      if (linkedActionErrors.length) {
        nextTasks = nextTasks.map((task) => {
          if (normalizeText(task && task.task_id) !== normalizeText(cardRecord && cardRecord.task_id)) {
            return task;
          }

          return {
            ...task,
            last_synced_at: new Date().toISOString(),
            last_sync_error: linkedActionErrors.join("; "),
          };
        });
        await writeTicketLinks(ticketId, nextTasks);
      }

      return buildSuccess({
        task: cardRecord,
        linked_tasks: nextTasks,
      });
    } catch (error) {
      return buildFailure("Unable to link the selected Trello card.", error);
    }
  },

  async unlinkTicketCard(args) {
    try {
      const requestArgs = parseArgs(args);
      const ticketId = normalizeText(requestArgs.ticket_id);
      const taskId = normalizeText(requestArgs.task_id);

      if (!ticketId || !taskId) {
        return buildFailure("Ticket ID and card ID are required.");
      }

      const existing = await readTicketLinks(ticketId);
      const nextTasks = existing.tasks.filter((task) => normalizeText(task && task.task_id) !== taskId);
      await writeTicketLinks(ticketId, nextTasks);
      await cleanupTrelloWebhookIfUnused(taskId, requestArgs.trello_api_key);

      return buildSuccess({
        linked_tasks: nextTasks,
      });
    } catch (error) {
      return buildFailure("Unable to unlink the Trello card.", error);
    }
  },

  async getClickupWorkspaces() {
    try {
      const payload = ensureSuccess(
        await invokeTemplate("clickup_workspaces", {}),
        "Could not load ClickUp workspaces."
      );
      const rawWorkspaces = Array.isArray(payload && payload.teams)
        ? payload.teams
        : Array.isArray(payload && payload.team)
        ? payload.team
        : [];
      const workspaces = rawWorkspaces
        .map(normalizeWorkspace)
        .filter(Boolean);

      return buildSuccess({ workspaces });
    } catch (error) {
      return buildFailure("Unable to load ClickUp workspaces.", error);
    }
  },

  async getClickupSpaces(args) {
    try {
      const requestArgs = parseArgs(args);
      const workspaceId = normalizeText(requestArgs.workspace_id);

      if (!workspaceId) {
        return buildFailure("Workspace ID is required.");
      }

      const payload = ensureSuccess(
        await invokeTemplate("clickup_spaces", {
          team_id: workspaceId,
        }),
        "Could not load ClickUp spaces."
      );
      const spaces = (Array.isArray(payload && payload.spaces) ? payload.spaces : [])
        .map(normalizeSpace)
        .filter(Boolean);

      return buildSuccess({ spaces });
    } catch (error) {
      return buildFailure("Unable to load ClickUp spaces.", error);
    }
  },

  async getClickupLists(args) {
    try {
      const requestArgs = parseArgs(args);
      const spaceId = normalizeText(requestArgs.space_id);

      if (!spaceId) {
        return buildFailure("Space ID is required.");
      }

      const payload = ensureSuccess(
        await invokeTemplate("clickup_lists", {
          space_id: spaceId,
        }),
        "Could not load ClickUp lists."
      );
      const lists = (Array.isArray(payload && payload.lists) ? payload.lists : [])
        .map(normalizeList)
        .filter(Boolean);

      return buildSuccess({ lists });
    } catch (error) {
      return buildFailure("Unable to load ClickUp lists.", error);
    }
  },

  async getClickupMembers(args) {
    try {
      const requestArgs = parseArgs(args);
      const workspaceId = normalizeText(requestArgs.workspace_id);

      if (!workspaceId) {
        return buildFailure("Workspace ID is required.");
      }

      const payload = ensureSuccess(
        await invokeTemplate("clickup_workspaces", {}),
        "Could not load ClickUp members."
      );
      const rawWorkspaces = Array.isArray(payload && payload.teams)
        ? payload.teams
        : Array.isArray(payload && payload.team)
        ? payload.team
        : [];
      const selectedWorkspace = rawWorkspaces.find((workspace) => {
        return normalizeText(workspace && workspace.id) === workspaceId;
      });
      const rawMembers = Array.isArray(selectedWorkspace && selectedWorkspace.members)
        ? selectedWorkspace.members
        : [];
      const members = rawMembers
        .map((member) => sanitizeMemberRecord(member && member.user ? member.user : member))
        .filter(Boolean);

      return buildSuccess({ members });
    } catch (error) {
      return buildFailure("Unable to load ClickUp members.", error);
    }
  },

  async getClickupTasks(args) {
    try {
      const requestArgs = parseArgs(args);
      const listId = normalizeText(requestArgs.list_id);

      if (!listId) {
        return buildFailure("List ID is required.");
      }

      const meta = {
        workspace_id: normalizeText(requestArgs.workspace_id),
        workspace_name: normalizeText(requestArgs.workspace_name),
        space_id: normalizeText(requestArgs.space_id),
        space_name: normalizeText(requestArgs.space_name),
        list_id: listId,
        list_name: normalizeText(requestArgs.list_name),
      };

      const tasks = [];

      for (let page = 0; page < 10; page += 1) {
        const payload = ensureSuccess(
          await invokeTemplate("clickup_tasks", {
            list_id: listId,
            page,
          }),
          "Could not load ClickUp tasks."
        );
        const pageTasks = Array.isArray(payload && payload.tasks) ? payload.tasks : [];

        pageTasks.forEach((task) => {
          const normalizedTask = normalizeTaskRecord(task, meta);
          if (normalizedTask) {
            tasks.push(normalizedTask);
          }
        });

        if (pageTasks.length < CLICKUP_PAGE_SIZE) {
          break;
        }
      }

      return buildSuccess({ tasks });
    } catch (error) {
      return buildFailure("Unable to load ClickUp tasks.", error);
    }
  },

  async createTicketTask(args) {
    try {
      const requestArgs = parseArgs(args);
      const ticketId = normalizeText(requestArgs.ticket_id);
      const listId = normalizeText(requestArgs.list_id);
      const title = normalizeText(requestArgs.title);
      const description = normalizeText(requestArgs.description);
      const priority = resolveClickupPriorityValue(requestArgs.priority);

      if (!ticketId || !listId || !title || !description || !priority) {
        return buildFailure("Ticket ID, title, description, list, and priority are required.");
      }

      const requestBody = {
        name: title,
        description,
        priority: Number(priority),
      };

      const assigneeId = normalizeText(requestArgs.assignee_id);
      const dueDateTimestamp = convertDateInputToTimestamp(requestArgs.due_date);

      if (assigneeId) {
        requestBody.assignees = [Number(assigneeId)];
      }

      if (dueDateTimestamp) {
        requestBody.due_date = dueDateTimestamp;
      }

      const createdTaskPayload = ensureSuccess(
        await invokeTemplate(
          "clickup_create",
          {
            list_id: listId,
          },
          requestBody
        ),
        "Could not create the ClickUp task."
      );

      const taskRecord = normalizeTaskRecord(createdTaskPayload, {
        workspace_id: normalizeText(requestArgs.workspace_id),
        workspace_name: normalizeText(requestArgs.workspace_name),
        space_id: normalizeText(requestArgs.space_id),
        space_name: normalizeText(requestArgs.space_name),
        list_id: listId,
        list_name: normalizeText(requestArgs.list_name),
        source: "created",
        linked_at: new Date().toISOString(),
      });

      const existing = await readTicketLinks(ticketId);
      const nextTasks = upsertLinkedTask(existing.tasks, taskRecord);
      const customFieldErrors = await applyMappedCustomFieldsToTask(
        taskRecord.task_id,
        requestArgs.field_mappings,
        requestArgs.ticket_custom_fields
      );

      const storedTasks = nextTasks.map((task) => {
        if (normalizeText(task && task.task_id) !== normalizeText(taskRecord && taskRecord.task_id)) {
          return task;
        }

        return {
          ...task,
          last_sync_error: customFieldErrors.join("; "),
        };
      });
      await writeTicketLinks(ticketId, storedTasks);

      return buildSuccess({
        task: taskRecord,
        linked_tasks: storedTasks,
      });
    } catch (error) {
      return buildFailure("Unable to create and link the ClickUp task.", error);
    }
  },

  async syncLinkedTicketTasks(args) {
    try {
      const requestArgs = parseArgs(args);
      const ticketId = normalizeText(requestArgs.ticket_id);
      const ticket = requestArgs.ticket || {};

      if (!ticketId) {
        return buildFailure("Ticket ID is required.");
      }

      if (!Object.keys(buildTicketSyncPayload(ticket)).length) {
        return buildFailure("Ticket details are not available to sync.");
      }

      const nextTasks = await syncStoredTasksWithTicket(ticketId, ticket, requestArgs.field_mappings);

      return buildSuccess({
        linked_tasks: nextTasks,
        synced_at: new Date().toISOString(),
      });
    } catch (error) {
      return buildFailure("Unable to sync linked ClickUp tasks.", error);
    }
  },

  async linkTicketTask(args) {
    try {
      const requestArgs = parseArgs(args);
      const ticketId = normalizeText(requestArgs.ticket_id);

      if (!ticketId || !requestArgs.task) {
        return buildFailure("Ticket ID and task details are required.");
      }

      const taskRecord = sanitizeTaskLinkPayload(requestArgs.task, {
        workspace_id: normalizeText(requestArgs.workspace_id),
        workspace_name: normalizeText(requestArgs.workspace_name),
        space_id: normalizeText(requestArgs.space_id),
        space_name: normalizeText(requestArgs.space_name),
        list_id: normalizeText(requestArgs.list_id),
        list_name: normalizeText(requestArgs.list_name),
        source: "linked",
      });

      if (!taskRecord) {
        return buildFailure("Task details are invalid.");
      }

      const existing = await readTicketLinks(ticketId);
      const nextTasks = upsertLinkedTask(existing.tasks, taskRecord);
      await writeTicketLinks(ticketId, nextTasks);

      return buildSuccess({
        task: taskRecord,
        linked_tasks: nextTasks,
      });
    } catch (error) {
      return buildFailure("Unable to link the selected ClickUp task.", error);
    }
  },

  async unlinkTicketTask(args) {
    try {
      const requestArgs = parseArgs(args);
      const ticketId = normalizeText(requestArgs.ticket_id);
      const taskId = normalizeText(requestArgs.task_id);

      if (!ticketId || !taskId) {
        return buildFailure("Ticket ID and task ID are required.");
      }

      const existing = await readTicketLinks(ticketId);
      const nextTasks = existing.tasks.filter((task) => {
        return normalizeText(task && task.task_id) !== taskId;
      });

      await writeTicketLinks(ticketId, nextTasks);

      return buildSuccess({
        linked_tasks: nextTasks,
      });
    } catch (error) {
      return buildFailure("Unable to unlink the ClickUp task.", error);
    }
  },
};
