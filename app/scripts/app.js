let client;

const DEFAULT_TRELLO_BRIDGE_HOST = "trello-connector-bridge.akashram-trello-bridge.workers.dev";

const state = {
  loading: true,
  loadingMessage: "Loading Trello details...",
  submitting: false,
  iparams: {},
  boards: [],
  labelsByBoard: {},
  membersByBoard: {},
  listsByBoard: {},
  cardsByList: {},
  form: {
    mode: "create",
    ticket: null,
    linkedTaskIds: [],
    title: "",
    description: "",
    boardId: "",
    listId: "",
    dueDate: "",
    memberIds: [],
    labelIds: [],
    taskId: "",
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
  await client.instance.resize({ height: "700px" });
  render();

  try {
    const context = await client.instance.context();
    const passedData = (context && context.data) || {};
    const iparams = await client.iparams.get();
    state.iparams = iparams && typeof iparams === "object" ? iparams : {};

    console.log("[Trello Modal] Runtime settings snapshot:", {
      trello_bridge_host_present: Boolean(getTrelloBridgeHost()),
      trello_token_present_in_client: Boolean(state.iparams && state.iparams.trello_token),
      trello_token_fingerprint: state.iparams && state.iparams.trello_token_fingerprint,
      trello_token_saved_at: state.iparams && state.iparams.trello_token_saved_at,
      trello_member_name: state.iparams && state.iparams.trello_member_name,
    });

    state.form.mode = passedData.mode === "link" ? "link" : "create";
    state.form.ticket = passedData.ticket || null;
    state.form.linkedTaskIds = Array.isArray(passedData.linked_task_ids) ? passedData.linked_task_ids : [];
    state.form.title = state.form.mode === "create" ? getTicketSubject() : "";
    state.form.description = state.form.mode === "create" ? getTicketDescription() : "";

    state.loadingMessage = "Loading Trello boards...";
    render();
    await loadBoardsIfNeeded();

    state.loadingMessage = "Preparing the Trello destination...";
    render();
    await prepareSelections();

    if (state.form.mode === "link" && state.form.listId) {
      state.loadingMessage = "Loading cards from the selected Trello list...";
      render();
      await loadCardsForListIfNeeded(state.form.listId, true);
      ensureSelectedCard();
    }
  } catch (error) {
    console.error("[Trello Modal] Failed to initialize modal:", error);
    showMessage(resolveErrorMessage(error, "Unable to load Trello data for this window."), "error");
  } finally {
    state.loading = false;
    state.loadingMessage = "";
    render();
  }
}

function bindRefs() {
  refs.modalEyebrow = document.getElementById("modalEyebrow");
  refs.modalTitle = document.getElementById("modalTitle");
  refs.modalCopy = document.getElementById("modalCopy");
  refs.ticketSummary = document.getElementById("ticketSummary");
  refs.statusBanner = document.getElementById("statusBanner");
  refs.modalMessage = document.getElementById("modalMessage");
  refs.detailsTitle = document.getElementById("detailsTitle");
  refs.detailsCopy = document.getElementById("detailsCopy");
  refs.createSection = document.getElementById("createSection");
  refs.linkSection = document.getElementById("linkSection");
  refs.taskTitle = document.getElementById("taskTitle");
  refs.taskDescription = document.getElementById("taskDescription");
  refs.dueDateInput = document.getElementById("dueDateInput");
  refs.memberSelect = document.getElementById("memberSelect");
  refs.labelPicker = document.getElementById("labelPicker");
  refs.labelPickerBtn = document.getElementById("labelPickerBtn");
  refs.labelPickerSwatch = document.getElementById("labelPickerSwatch");
  refs.labelPickerText = document.getElementById("labelPickerText");
  refs.labelPickerDropdown = document.getElementById("labelPickerDropdown");
  refs.taskSelect = document.getElementById("taskSelect");
  refs.boardSelect = document.getElementById("boardSelect");
  refs.listSelect = document.getElementById("listSelect");
  refs.cancelBtn = document.getElementById("cancelBtn");
  refs.submitBtn = document.getElementById("submitBtn");
}

function bindEvents() {
  refs.cancelBtn.addEventListener("click", () => {
    if (!state.submitting) {
      client.instance.close();
    }
  });

  refs.submitBtn.addEventListener("click", () => {
    void submit();
  });

  refs.taskTitle.addEventListener("input", (event) => {
    state.form.title = event.target.value;
  });
  refs.taskDescription.addEventListener("input", (event) => {
    state.form.description = event.target.value;
  });
  refs.dueDateInput.addEventListener("change", (event) => {
    state.form.dueDate = event.target.value;
  });
  refs.memberSelect.addEventListener("change", (event) => {
    state.form.memberIds = event.target.value ? [event.target.value] : [];
  });
  refs.labelPickerBtn.addEventListener("click", () => {
    if (!refs.labelPickerBtn.disabled) {
      toggleLabelPicker();
    }
  });
  document.addEventListener("click", (event) => {
    if (refs.labelPicker && !refs.labelPicker.contains(event.target)) {
      closeLabelPicker();
    }
  });
  refs.taskSelect.addEventListener("change", (event) => {
    state.form.taskId = event.target.value;
  });
  refs.boardSelect.addEventListener("change", () => {
    void handleBoardChange();
  });
  refs.listSelect.addEventListener("change", () => {
    void handleListChange();
  });
}

function render() {
  const isCreate = state.form.mode === "create";
  const disableForm = state.loading || state.submitting;

  refs.modalEyebrow.textContent = isCreate ? "Create in Trello" : "Link in Trello";
  refs.modalTitle.textContent = isCreate ? "Create Trello Card" : "Link Existing Trello Card";
  refs.modalCopy.textContent = isCreate
    ? "Create a new Trello card from this ticket and link it immediately."
    : "Choose the Trello board and list, then pick an existing card to link.";
  refs.detailsTitle.textContent = isCreate ? "Card Details" : "Card Selection";
  refs.detailsCopy.textContent = isCreate
    ? "The ticket title and description are prefilled for you, and you can adjust them before creating the card."
    : "Once you pick a board and list, available cards from that list will appear below.";

  refs.createSection.classList.toggle("hidden", !isCreate);
  refs.linkSection.classList.toggle("hidden", isCreate);
  refs.ticketSummary.textContent = buildTicketSummary();

  refs.taskTitle.value = state.form.title;
  refs.taskDescription.value = state.form.description;
  refs.dueDateInput.value = state.form.dueDate;
  refs.memberSelect.innerHTML = buildMultiSelectOptions(
    getMembersForCurrentBoard().map((member) => ({
      id: member.id,
      name: member.name,
    })),
    state.form.memberIds[0] || "",
    state.form.boardId ? "Select a member" : "Choose a board first"
  );
  renderLabelPicker(disableForm);
  refs.boardSelect.innerHTML = buildSelectOptions(
    state.boards,
    state.form.boardId,
    state.loading ? "Loading boards..." : "Select a board"
  );
  refs.listSelect.innerHTML = buildSelectOptions(
    getListsForCurrentBoard(),
    state.form.listId,
    state.form.boardId ? "Select a list" : "Choose a board first"
  );
  refs.taskSelect.innerHTML = buildSelectOptions(
    getLinkableCardsForCurrentList().map((card) => ({
      id: card.task_id,
      name: card.task_name,
    })),
    state.form.taskId,
    getCardSelectPlaceholder()
  );

  refs.taskTitle.disabled = disableForm;
  refs.taskDescription.disabled = disableForm;
  refs.dueDateInput.disabled = disableForm;
  refs.memberSelect.disabled = disableForm || !state.form.boardId;
  refs.taskSelect.disabled = disableForm || !state.form.listId;
  refs.boardSelect.disabled = disableForm;
  refs.listSelect.disabled = disableForm || !state.form.boardId;
  refs.cancelBtn.disabled = state.submitting;
  refs.submitBtn.disabled = disableForm;
  refs.submitBtn.textContent = state.submitting
    ? isCreate
      ? "Creating..."
      : "Linking..."
    : isCreate
    ? "Create and Link"
    : "Link Card";

  renderStatus();
  renderMessage();
}

function renderStatus() {
  let text = "";

  if (state.submitting) {
    text = state.form.mode === "create"
      ? "Creating the Trello card and linking it to this ticket..."
      : "Linking the selected Trello card to this ticket...";
  } else if (state.loading && state.loadingMessage) {
    text = state.loadingMessage;
  }

  refs.statusBanner.textContent = text;
  refs.statusBanner.classList.toggle("is-visible", Boolean(text));
}

function renderMessage() {
  if (!state.message.text) {
    refs.modalMessage.textContent = "";
    refs.modalMessage.className = "message";
    return;
  }

  refs.modalMessage.textContent = state.message.text;
  refs.modalMessage.className = `message ${state.message.type || "error"} is-visible`;
}

async function handleBoardChange() {
  state.form.boardId = refs.boardSelect.value;
  state.form.listId = "";
  state.form.taskId = "";
  state.form.memberIds = [];
  state.form.labelIds = [];
  clearMessage();
  state.loading = true;
  state.loadingMessage = "Loading board details...";
  render();

  try {
    await prepareSelections();
  } catch (error) {
    showMessage(resolveErrorMessage(error, "Unable to refresh the selected board."), "error");
  } finally {
    state.loading = false;
    state.loadingMessage = "";
    render();
  }
}

async function handleListChange() {
  state.form.listId = refs.listSelect.value;
  state.form.taskId = "";
  clearMessage();

  if (state.form.mode !== "link" || !state.form.listId) {
    render();
    return;
  }

  state.loading = true;
  state.loadingMessage = "Loading cards from the selected Trello list...";
  render();

  try {
    await loadCardsForListIfNeeded(state.form.listId, true);
    ensureSelectedCard();
  } catch (error) {
    showMessage(resolveErrorMessage(error, "Unable to refresh the selected list."), "error");
  } finally {
    state.loading = false;
    state.loadingMessage = "";
    render();
  }
}

async function submit() {
  clearMessage();

  if (state.form.mode === "create") {
    await submitCreate();
    return;
  }

  await submitLink();
}

async function submitCreate() {
  const validationError = validateCreate();
  if (validationError) {
    showMessage(validationError, "error");
    render();
    return;
  }

  state.submitting = true;
  render();

  try {
    const payload = await invokeServerFunction("createTicketCard", {
      ticket_id: getTicketId(),
      ticket: getTicketPayload(),
      title: state.form.title,
      description: state.form.description,
      board_id: state.form.boardId,
      board_name: getBoardName(state.form.boardId),
      list_id: state.form.listId,
      list_name: getListName(state.form.listId),
      due_date: state.form.dueDate,
      member_ids: state.form.memberIds,
      members: getSelectedMembers(),
      label_ids: state.form.labelIds,
      labels: getSelectedLabels(),
      trello_bridge_host: getTrelloBridgeHost(),
      trello_to_freshdesk_notifications: state.iparams.trello_to_freshdesk_notifications || {},
      freshdesk_to_trello_notifications: state.iparams.freshdesk_to_trello_notifications || {},
    });

    await client.instance.send({
      message: {
        linked_tasks: payload.linked_tasks || [],
        notice: "Trello card created and linked successfully.",
      },
    });
    await client.instance.close();
  } catch (error) {
    state.submitting = false;
    showMessage(resolveErrorMessage(error, "Unable to create the Trello card."), "error");
    render();
  }
}

async function submitLink() {
  const validationError = validateLink();
  if (validationError) {
    showMessage(validationError, "error");
    render();
    return;
  }

  state.submitting = true;
  render();

  try {
    const selectedCard = getLinkableCardsForCurrentList().find((card) => card.task_id === state.form.taskId);
    if (!selectedCard) {
      throw new Error("Select a Trello card to link.");
    }

    const payload = await invokeServerFunction("linkTicketCard", {
      ticket_id: getTicketId(),
      ticket: getTicketPayload(),
      board_id: state.form.boardId,
      board_name: getBoardName(state.form.boardId),
      list_id: state.form.listId,
      list_name: getListName(state.form.listId),
      task: selectedCard,
      trello_bridge_host: getTrelloBridgeHost(),
      trello_to_freshdesk_notifications: state.iparams.trello_to_freshdesk_notifications || {},
      freshdesk_to_trello_notifications: state.iparams.freshdesk_to_trello_notifications || {},
    });

    await client.instance.send({
      message: {
        linked_tasks: payload.linked_tasks || [],
        notice: "Trello card linked successfully.",
      },
    });
    await client.instance.close();
  } catch (error) {
    state.submitting = false;
    showMessage(resolveErrorMessage(error, "Unable to link the selected Trello card."), "error");
    render();
  }
}

function validateCreate() {
  if (!state.form.title.trim()) {
    return "Card title is required.";
  }
  if (!state.form.description.trim()) {
    return "Card description is required.";
  }
  if (!state.form.boardId || !state.form.listId) {
    return "Board and list are required.";
  }
  return "";
}

function validateLink() {
  if (!state.form.boardId || !state.form.listId) {
    return "Board and list are required.";
  }
  if (!state.form.taskId) {
    return "Select a Trello card to link.";
  }
  return "";
}

async function loadBoardsIfNeeded() {
  if (state.boards.length) {
    return;
  }

  const payload = await invokeServerFunction("getTrelloBoards", {
    trello_bridge_host: getTrelloBridgeHost(),
    trello_token_fingerprint: state.iparams && state.iparams.trello_token_fingerprint,
    trello_token_saved_at: state.iparams && state.iparams.trello_token_saved_at,
  });
  state.boards = Array.isArray(payload.boards) ? payload.boards : [];
}

async function prepareSelections() {
  state.form.boardId = pickAvailableId(state.boards, state.form.boardId);

  if (!state.form.boardId) {
    state.form.listId = "";
    return;
  }

  await loadListsForBoardIfNeeded(state.form.boardId);
  await loadMembersForBoardIfNeeded(state.form.boardId);
  await loadLabelsForBoardIfNeeded(state.form.boardId);
  state.form.listId = pickAvailableId(getListsForCurrentBoard(), state.form.listId);
  state.form.memberIds = pickSingleAvailableId(getMembersForCurrentBoard(), state.form.memberIds);
  state.form.labelIds = pickSingleAvailableId(getLabelsForCurrentBoard(), state.form.labelIds);
}

async function loadListsForBoardIfNeeded(boardId) {
  if (!boardId || state.listsByBoard[boardId]) {
    return;
  }

  const payload = await invokeServerFunction("getTrelloLists", {
    board_id: boardId,
    trello_bridge_host: getTrelloBridgeHost(),
  });

  state.listsByBoard[boardId] = Array.isArray(payload.lists) ? payload.lists : [];
}

async function loadMembersForBoardIfNeeded(boardId) {
  if (!boardId || state.membersByBoard[boardId]) {
    return;
  }

  const payload = await invokeServerFunction("getTrelloMembers", {
    board_id: boardId,
    trello_bridge_host: getTrelloBridgeHost(),
  });

  state.membersByBoard[boardId] = Array.isArray(payload.members) ? payload.members : [];
}

async function loadLabelsForBoardIfNeeded(boardId) {
  if (!boardId || state.labelsByBoard[boardId]) {
    return;
  }

  const payload = await invokeServerFunction("getTrelloLabels", {
    board_id: boardId,
    trello_bridge_host: getTrelloBridgeHost(),
  });

  state.labelsByBoard[boardId] = Array.isArray(payload.labels) ? payload.labels : [];
}

async function loadCardsForListIfNeeded(listId, forceReload) {
  if (!listId) {
    return;
  }

  if (!forceReload && state.cardsByList[listId]) {
    return;
  }

  const payload = await invokeServerFunction("getTrelloCards", {
    board_id: state.form.boardId,
    board_name: getBoardName(state.form.boardId),
    list_id: listId,
    list_name: getListName(listId),
    trello_bridge_host: getTrelloBridgeHost(),
  });

  state.cardsByList[listId] = Array.isArray(payload.cards) ? payload.cards : [];
}

function getListsForCurrentBoard() {
  return state.listsByBoard[state.form.boardId] || [];
}

function getMembersForCurrentBoard() {
  return state.membersByBoard[state.form.boardId] || [];
}

function getLabelsForCurrentBoard() {
  return state.labelsByBoard[state.form.boardId] || [];
}

function getLinkableCardsForCurrentList() {
  const linkedIds = new Set(state.form.linkedTaskIds);
  return (state.cardsByList[state.form.listId] || []).filter((card) => !linkedIds.has(card.task_id));
}

function getCardSelectPlaceholder() {
  if (!state.form.listId) {
    return "Choose a list first";
  }
  if (state.loading) {
    return "Loading cards...";
  }
  if (!getLinkableCardsForCurrentList().length) {
    return "No unlinked cards found in this list";
  }
  return "Select a card";
}

function ensureSelectedCard() {
  state.form.taskId = pickAvailableId(
    getLinkableCardsForCurrentList().map((card) => ({ id: card.task_id })),
    state.form.taskId
  );
}

function getSelectedMembers() {
  const selectedIds = new Set(state.form.memberIds);
  return getMembersForCurrentBoard().filter((member) => selectedIds.has(member.id));
}

function getSelectedLabels() {
  const selectedIds = new Set(state.form.labelIds);
  return getLabelsForCurrentBoard().filter((label) => selectedIds.has(label.id));
}

function getBoardName(boardId) {
  const match = state.boards.find((board) => board.id === boardId);
  return match ? match.name : "";
}

function getListName(listId) {
  const match = getListsForCurrentBoard().find((list) => list.id === listId);
  return match ? match.name : "";
}

function pickAvailableId(items, preferredId) {
  const preferred = normalizeText(preferredId);
  const options = Array.isArray(items) ? items : [];

  if (preferred && options.some((item) => item.id === preferred)) {
    return preferred;
  }

  return options.length ? options[0].id : "";
}

function pickSingleAvailableId(items, preferredIds) {
  const firstPreferred = Array.isArray(preferredIds) && preferredIds.length ? preferredIds[0] : "";
  const options = Array.isArray(items) ? items : [];

  if (firstPreferred && options.some((item) => item.id === firstPreferred)) {
    return [firstPreferred];
  }

  return [];
}

function buildSelectOptions(items, selectedId, placeholder) {
  const options = Array.isArray(items) ? items : [];
  return `<option value="">${escapeHtml(placeholder || "Select an option")}</option>${options
    .map((item) => {
      const selected = item.id === selectedId ? " selected" : "";
      return `<option value="${escapeAttribute(item.id)}"${selected}>${escapeHtml(item.name)}</option>`;
    })
    .join("")}`;
}

function buildMultiSelectOptions(items, selectedId, placeholder) {
  return buildSelectOptions(items, selectedId, placeholder);
}

function renderLabelPicker(disableForm) {
  closeLabelPicker();
  const labels = getLabelsForCurrentBoard();
  const selectedId = state.form.labelIds[0] || "";
  const placeholder = state.form.boardId ? "Select a label" : "Choose a board first";
  const isDisabled = disableForm || !state.form.boardId;

  refs.labelPickerBtn.disabled = isDisabled;

  const selectedLabel = labels.find((label) => label.id === selectedId);
  if (selectedLabel) {
    const hex = getTrelloActualColor(normalizeText(selectedLabel.color).toLowerCase());
    refs.labelPickerSwatch.style.background = hex || "#c2cfe0";
    refs.labelPickerText.textContent = formatLabelOption(selectedLabel);
  } else {
    refs.labelPickerSwatch.style.background = "transparent";
    refs.labelPickerText.textContent = placeholder;
  }

  const noneHtml = `
    <button type="button" class="label-picker-option${!selectedId ? " is-selected" : ""}" data-value="">
      <span class="label-picker-option-swatch" style="background: #e5e9ef;"></span>
      <span>None</span>
    </button>
  `;
  const optionsHtml = labels.map((label) => {
    const id = normalizeText(label && label.id);
    const name = formatLabelOption(label);
    const hex = getTrelloActualColor(normalizeText(label && label.color).toLowerCase()) || "#c2cfe0";
    const isSelected = id === selectedId;
    return `
      <button type="button" class="label-picker-option${isSelected ? " is-selected" : ""}" data-value="${escapeAttribute(id)}">
        <span class="label-picker-option-swatch" style="background: ${escapeAttribute(hex)};"></span>
        <span>${escapeHtml(name)}</span>
      </button>
    `;
  }).join("");

  refs.labelPickerDropdown.innerHTML = noneHtml + optionsHtml;

  refs.labelPickerDropdown.querySelectorAll(".label-picker-option").forEach((btn) => {
    btn.addEventListener("click", () => {
      const value = btn.getAttribute("data-value");
      state.form.labelIds = value ? [value] : [];
      closeLabelPicker();
      render();
    });
  });
}

function toggleLabelPicker() {
  if (refs.labelPickerDropdown.classList.contains("hidden")) {
    refs.labelPickerDropdown.classList.remove("hidden");
    refs.labelPicker.classList.add("is-open");
  } else {
    closeLabelPicker();
  }
}

function closeLabelPicker() {
  if (refs.labelPickerDropdown) {
    refs.labelPickerDropdown.classList.add("hidden");
  }
  if (refs.labelPicker) {
    refs.labelPicker.classList.remove("is-open");
  }
}

function getTrelloActualColor(color) {
  const palette = {
    // Standard
    green: "#61bd4f",
    yellow: "#f2d600",
    orange: "#ff9f1a",
    red: "#eb5a46",
    purple: "#c377e0",
    blue: "#0079bf",
    sky: "#00c2e0",
    lime: "#51e898",
    pink: "#ff78cb",
    black: "#344563",
    // Dark
    green_dark: "#519839",
    yellow_dark: "#d9b51c",
    orange_dark: "#d17711",
    red_dark: "#b04632",
    purple_dark: "#89609e",
    blue_dark: "#055a8c",
    sky_dark: "#0098b7",
    lime_dark: "#4bbf6b",
    pink_dark: "#e06ba2",
    black_dark: "#1d2d44",
    // Light
    green_light: "#b7ddb0",
    yellow_light: "#f5ea92",
    orange_light: "#fad29c",
    red_light: "#efb3ab",
    purple_light: "#dfc0eb",
    blue_light: "#8bbdd9",
    sky_light: "#8fdfeb",
    lime_light: "#b3f1d0",
    pink_light: "#f9c2e4",
    black_light: "#b6bfcb",
  };
  return palette[normalizeText(color).toLowerCase()] || "";
}

function formatLabelOption(label) {
  const name = normalizeText(label && label.name);
  const color = normalizeText(label && label.color).toLowerCase();
  const colorName = formatTrelloColorName(color);

  if (name && colorName) {
    return `${name} (${colorName})`;
  }

  return name || colorName || "Unnamed label";
}

function formatTrelloColorName(color) {
  const names = {
    green: "Green", yellow: "Yellow", orange: "Orange", red: "Red",
    purple: "Purple", blue: "Blue", sky: "Sky", lime: "Lime",
    pink: "Pink", black: "Black",
    green_dark: "Dark Green", yellow_dark: "Dark Yellow", orange_dark: "Dark Orange",
    red_dark: "Dark Red", purple_dark: "Dark Purple", blue_dark: "Dark Blue",
    sky_dark: "Dark Sky", lime_dark: "Dark Lime", pink_dark: "Dark Pink",
    black_dark: "Dark Black",
    green_light: "Light Green", yellow_light: "Light Yellow", orange_light: "Light Orange",
    red_light: "Light Red", purple_light: "Light Purple", blue_light: "Light Blue",
    sky_light: "Light Sky", lime_light: "Light Lime", pink_light: "Light Pink",
    black_light: "Light Black",
  };
  return names[color] || (color ? `${color.charAt(0).toUpperCase()}${color.slice(1)}` : "");
}

function buildTicketSummary() {
  const ticketId = getTicketId();
  const subject = getTicketSubject();

  if (!ticketId) {
    return "Freshdesk ticket details are not available in this window yet.";
  }

  return `Ticket #${ticketId}${subject ? `: ${subject}` : ""}`;
}

function getTicketId() {
  return normalizeText(state.form.ticket && state.form.ticket.id);
}

function getTicketSubject() {
  return normalizeText(state.form.ticket && state.form.ticket.subject);
}

function getTicketDescription() {
  return normalizeText(state.form.ticket && state.form.ticket.descriptionText);
}

function getTicketPayload() {
  return {
    id: getTicketId(),
    subject: getTicketSubject(),
    description_text: getTicketDescription(),
    url: buildFreshdeskTicketUrl(getTicketId()),
  };
}

function getTrelloBridgeHost() {
  return (
    normalizeText(state.iparams && state.iparams.trello_bridge_host) ||
    DEFAULT_TRELLO_BRIDGE_HOST
  );
}

function buildFreshdeskTicketUrl(ticketId) {
  const normalizedTicketId = normalizeText(ticketId);
  const domain = normalizeFreshdeskDomain(state.iparams && state.iparams.domain);

  if (!normalizedTicketId || !domain) {
    return "";
  }

  return `https://${domain}/a/tickets/${encodeURIComponent(normalizedTicketId)}`;
}

function normalizeFreshdeskDomain(value) {
  return normalizeText(value).replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

async function invokeServerFunction(name, body) {
  const result = await client.request.invoke(name, {
    body,
  });
  const payload = parseInvokeResponse(result);

  if (!payload || payload.success === false) {
    console.error("[Trello Modal] Server function failed:", {
      name,
      requestBody: body,
      rawResult: result,
      parsedPayload: payload,
    });
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

  const message = normalizeText(payload.message);
  const detail = normalizeText(payload.detail);

  if (detail && detail !== message) {
    if (!message || /^unable to |^could not |^request failed/i.test(message)) {
      return detail;
    }

    return `${message} ${detail}`;
  }

  return message || detail || "";
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

function escapeAttribute(value) {
  return escapeHtml(value);
}
