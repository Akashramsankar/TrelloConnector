const TRELLO_APP_KEY = "81c7dea8b018a4a14f3275147eabd758";
const TRELLO_AUTH_POPUP_NAME = "trello-connector-auth";
const TRELLO_AUTH_TIMEOUT_MS = 120000;
const TRELLO_CALLBACK_PAGE_URL = "https://akashramsankar.github.io/TrelloConnector/trello_auth_complete.html";
const TRELLO_CALLBACK_ORIGIN = new URL(TRELLO_CALLBACK_PAGE_URL).origin;
const TRELLO_TO_FRESHDESK_EVENTS = [
  { key: "ticket_linked", label: "A ticket is connected to a Trello card" },
  { key: "card_moved", label: "A linked card is moved to another list" },
  { key: "card_comment_added", label: "Someone comments on a linked card" },
  { key: "card_member_added", label: "A member is added to a linked card" },
  { key: "card_labels_updated", label: "Labels change on a linked card" },
  { key: "card_due_date_updated", label: "The due date changes on a linked card" },
  { key: "card_attachment_added", label: "A file is attached to a linked card" },
  { key: "card_archived", label: "A linked card is archived" },
];
const FRESHDESK_TO_TRELLO_EVENTS = [
  { key: "ticket_linked", label: "A ticket is connected to a Trello card" },
  { key: "private_note_added", label: "A private note is added to the ticket" },
  { key: "public_note_added", label: "A public note is added to the ticket" },
  { key: "agent_reply_added", label: "An agent reply is sent from the ticket" },
  { key: "ticket_forwarded", label: "The ticket is forwarded" },
];
const FRESHDESK_ACTION_OPTIONS = [
  { value: "none", label: "Leave the ticket unchanged" },
  { value: "private_note_notify", label: "Add a private note and alert the assignee" },
  { value: "public_note", label: "Add a public note on the ticket" },
];
const TRELLO_ACTION_OPTIONS = [
  { value: "none", label: "Do not post anything" },
  { value: "comment", label: "Add a comment to the linked Trello card" },
];

const state = {
  client: null,
  initialized: false,
  initializing: null,
  hydrating: false,
  autoPopupAttempted: false,
  savedConfigs: {},
  sessionSecrets: {
    trelloToken: "",
    freshdeskAuth: "",
  },
  trelloVerified: false,
  freshdeskVerified: false,
  trelloAuthInFlight: false,
  trelloAuthTimeoutId: null,
  connectedTrelloMember: null,
  notificationPreferences: {
    trelloToFreshdesk: {},
    freshdeskToTrello: {},
  },
};

const refs = {};
document.addEventListener("DOMContentLoaded", () => {
  void ensureInitialized();
});

function ensureInitialized() {
  if (!state.initializing) {
    state.initializing = initialize();
  }
  return state.initializing;
}

async function initialize() {
  state.client = await app.initialized();
  bindRefs();
  bindEvents();
  state.initialized = true;
  await hydrateFromConfigs(state.savedConfigs);
}

function bindRefs() {
  refs.connectTrelloBtn = document.getElementById("connectTrelloBtn");
  refs.resetTrelloBtn = document.getElementById("resetTrelloBtn");
  refs.trelloStatusLine = document.getElementById("trelloStatusLine");
  refs.trelloConnectionSummary = document.getElementById("trelloConnectionSummary");
  refs.trelloMemberName = document.getElementById("trelloMemberName");
  refs.trelloMemberMeta = document.getElementById("trelloMemberMeta");
  refs.trelloMessage = document.getElementById("trelloMessage");

  refs.domain = document.getElementById("domain");
  refs.apiKey = document.getElementById("apiKey");
  refs.verifyFreshdeskBtn = document.getElementById("verifyFreshdeskBtn");
  refs.freshdeskStatusLine = document.getElementById("freshdeskStatusLine");
  refs.freshdeskMessage = document.getElementById("freshdeskMessage");

  refs.notificationSettingsSection = document.getElementById("notificationSettingsSection");
  refs.trelloToFreshdeskList = document.getElementById("trelloToFreshdeskList");
  refs.freshdeskToTrelloList = document.getElementById("freshdeskToTrelloList");
}

function bindEvents() {
  refs.connectTrelloBtn.addEventListener("click", (event) => {
    clearMessage(refs.trelloMessage);
    if (!refs.connectTrelloBtn.href || refs.connectTrelloBtn.href.endsWith("#")) {
      event.preventDefault();
      showMessage(refs.trelloMessage, "Trello sign-in link is not ready yet. Refresh and try again.", "error");
      return;
    }
    markTrelloAuthPending();
    const opened = openTrelloAuthPopup(refs.connectTrelloBtn.href);
    if (opened) {
      event.preventDefault();
      showMessage(refs.trelloMessage, "Finish signing into Trello in the popup window.", "info");
      return;
    }
    showMessage(refs.trelloMessage, "Popup was blocked, so Trello will open in a new tab instead.", "info");
  });

  refs.resetTrelloBtn.addEventListener("click", (event) => {
    clearTrelloConnection({ clearSavedConfigKey: true });
    clearMessage(refs.trelloMessage);
    if (!refs.resetTrelloBtn.href || refs.resetTrelloBtn.href.endsWith("#")) {
      event.preventDefault();
      showMessage(refs.trelloMessage, "Trello sign-in link is not ready yet. Refresh and try again.", "error");
      return;
    }
    markTrelloAuthPending();
    const opened = openTrelloAuthPopup(refs.resetTrelloBtn.href);
    if (opened) {
      event.preventDefault();
      showMessage(refs.trelloMessage, "Finish signing into Trello in the popup window.", "info");
      return;
    }
    showMessage(refs.trelloMessage, "Popup was blocked, so Trello will open in a new tab instead.", "info");
  });

  refs.verifyFreshdeskBtn.addEventListener("click", () => {
    void verifyFreshdeskCredentials();
  });

  refs.domain.addEventListener("input", () => {
    clearMessage(refs.freshdeskMessage);
    clearFreshdeskVerification();
  });

  refs.apiKey.addEventListener("input", () => {
    clearMessage(refs.freshdeskMessage);
    clearFreshdeskVerification();
  });

  refs.trelloToFreshdeskList.addEventListener("change", handleNotificationSelectionChange);
  refs.freshdeskToTrelloList.addEventListener("change", handleNotificationSelectionChange);

  window.addEventListener("message", (event) => {
    void handleTrelloAuthMessage(event);
  });
}

async function hydrateFromConfigs(configs) {
  if (!state.initialized || state.hydrating) {
    return;
  }

  state.hydrating = true;

  try {
    const safeConfigs = configs || {};

    refs.domain.value = safeConfigs.domain || "";
    refs.apiKey.value = "";

    state.sessionSecrets.trelloToken = safeConfigs.trello_token || "";
    state.sessionSecrets.freshdeskAuth = safeConfigs.api_key || "";
    state.trelloVerified = Boolean(safeConfigs.trello_token);
    state.freshdeskVerified = Boolean(safeConfigs.domain && safeConfigs.api_key);
    state.connectedTrelloMember = safeConfigs.trello_member_name
      ? {
          name: safeConfigs.trello_member_name,
          username: safeConfigs.trello_member_username || "",
          url: safeConfigs.trello_member_url || "",
        }
      : null;
    state.notificationPreferences = {
      trelloToFreshdesk: normalizeNotificationPreferences(
        safeConfigs.trello_to_freshdesk_notifications,
        TRELLO_TO_FRESHDESK_EVENTS,
        resolveTrelloToFreshdeskMode(safeConfigs)
      ),
      freshdeskToTrello: normalizeNotificationPreferences(
        safeConfigs.freshdesk_to_trello_notifications,
        FRESHDESK_TO_TRELLO_EVENTS,
        resolveFreshdeskToTrelloMode(safeConfigs)
      ),
    };

    applyTrelloAuthorizationLinks();
    renderNotificationSettings();
    updateTrelloStatus();
    updateFreshdeskStatus();
    updateNotificationVisibility();
  } finally {
    state.hydrating = false;
  }

  maybeAutoOpenTrelloPopup();
}

function getActiveTrelloApiKey() {
  return String(TRELLO_APP_KEY || "").trim();
}

function getActiveTrelloToken() {
  return String(state.sessionSecrets.trelloToken || state.savedConfigs.trello_token || "").trim();
}

function buildTokenFingerprint(token) {
  const normalized = String(token || "").trim();
  if (!normalized) {
    return "";
  }

  const suffix = normalized.slice(-4);
  return `len:${normalized.length}:end:${suffix}`;
}

function getActiveFreshdeskAuth() {
  const freshdeskKey = String(refs.apiKey.value || "").trim();
  if (freshdeskKey) {
    return btoa(`${freshdeskKey}:X`);
  }

  return state.sessionSecrets.freshdeskAuth || state.savedConfigs.api_key || "";
}

function applyTrelloAuthorizationLinks() {
  const trelloApiKey = getActiveTrelloApiKey();
  const returnUrl = buildTrelloAuthReturnUrl();
  const authorizeUrl = trelloApiKey ? buildTrelloAuthorizeUrl(trelloApiKey, returnUrl) : "#";

  refs.connectTrelloBtn.href = authorizeUrl;
  refs.resetTrelloBtn.href = authorizeUrl;
  refs.connectTrelloBtn.target = TRELLO_AUTH_POPUP_NAME;
  refs.resetTrelloBtn.target = TRELLO_AUTH_POPUP_NAME;
}

function buildTrelloAuthReturnUrl() {
  const callbackUrl = new URL(TRELLO_CALLBACK_PAGE_URL);
  callbackUrl.searchParams.set("parent_origin", window.location.origin);
  return callbackUrl.toString();
}

function maybeAutoOpenTrelloPopup() {
  if (state.autoPopupAttempted || state.trelloVerified || state.trelloAuthInFlight) {
    return;
  }

  state.autoPopupAttempted = true;

  if (!refs.connectTrelloBtn.href || refs.connectTrelloBtn.href.endsWith("#")) {
    return;
  }

  markTrelloAuthPending();
  const opened = openTrelloAuthPopup(refs.connectTrelloBtn.href);

  if (opened) {
    showMessage(refs.trelloMessage, "Trello sign-in opened automatically. Finish signing in to continue.", "info");
    return;
  }

  cleanupTrelloAuthFlow();
  showMessage(refs.trelloMessage, "If Trello did not open automatically, click Connect Trello to continue.", "info");
}

function buildTrelloAuthorizeUrl(trelloApiKey, returnUrl) {
  const params = new URLSearchParams({
    callback_method: "fragment",
    expiration: "never",
    key: trelloApiKey,
    name: "Freshdesk Trello Connector",
    response_type: "token",
    return_url: returnUrl,
    scope: "read,write,account",
  });

  return `https://trello.com/1/authorize?${params.toString()}`;
}

async function handleTrelloAuthMessage(event) {
  const isTrelloMessage = event && event.origin === "https://trello.com";
  const isHostedCallbackMessage =
    event &&
    event.origin === TRELLO_CALLBACK_ORIGIN &&
    event.data &&
    typeof event.data === "object" &&
    event.data.source === "trello-auth-callback";

  if (!isTrelloMessage && !isHostedCallbackMessage) {
    return;
  }

  cleanupTrelloAuthFlow();

  const data = event.data;
  const message = typeof data === "string" ? data.trim() : "";
  const token =
    typeof data === "string"
      ? data.trim()
      : data && typeof data.token === "string"
      ? data.token.trim()
      : "";
  const error =
    data && typeof data === "object" && typeof data.error === "string"
      ? data.error.trim()
      : message.toLowerCase().includes("rejected")
      ? message
      : "";

  if (error) {
    showMessage(refs.trelloMessage, "Trello authorization was cancelled. Click Connect Trello to try again.", "error");
    return;
  }

  if (!token) {
    showMessage(refs.trelloMessage, "Trello did not return a token. Click Connect Trello to try again.", "error");
    return;
  }

  await verifyTrelloConnection(token);
}

async function verifyTrelloConnection(token) {
  const trelloApiKey = getActiveTrelloApiKey();

  if (!trelloApiKey) {
    showMessage(refs.trelloMessage, "Trello is not configured for this app yet.", "error");
    return;
  }

  try {
    showMessage(refs.trelloMessage, "Verifying Trello connection...", "info");

    const response = await state.client.request.invokeTemplate("verify_trello_connection", {
      context: {
        trello_api_key: trelloApiKey,
        trello_token: token,
      },
    });

    if (Number(response.status) !== 200) {
      throw new Error("Trello credentials are not valid.");
    }

    const payload = safeParseJson(response.response, {});
    state.sessionSecrets.trelloToken = token;
    state.trelloVerified = true;
    state.connectedTrelloMember = normalizeTrelloMember(payload);

    updateTrelloStatus();
    updateNotificationVisibility();
    showMessage(refs.trelloMessage, "Trello connected.", "success");
  } catch (error) {
    console.error("Failed to verify Trello connection:", error);
    clearTrelloConnection({ clearSavedConfigKey: false });
    showMessage(refs.trelloMessage, "Could not verify Trello. Click Connect Trello to try again.", "error");
  }
}

function normalizeTrelloMember(payload) {
  return {
    name: String(payload && (payload.fullName || payload.username || "Trello member")).trim(),
    username: String(payload && payload.username ? payload.username : "").trim(),
    url: String(payload && payload.url ? payload.url : "").trim(),
  };
}

async function verifyFreshdeskCredentials() {
  const domain = normalizeDomain(refs.domain.value);
  const encodedAuth = getActiveFreshdeskAuth();
  clearMessage(refs.freshdeskMessage);

  if (!domain) {
    showMessage(refs.freshdeskMessage, "Enter the Freshdesk domain.", "error");
    return;
  }

  if (!encodedAuth) {
    showMessage(refs.freshdeskMessage, "Enter the Freshdesk API key.", "error");
    return;
  }

  try {
    showMessage(refs.freshdeskMessage, "Verifying Freshdesk...", "info");

    const response = await state.client.request.invokeTemplate("verify_freshdesk_credentials", {
      context: {
        domain,
        encoded_auth: encodedAuth,
      },
    });

    if (Number(response.status) !== 200) {
      throw new Error("Freshdesk credentials are not valid.");
    }

    state.freshdeskVerified = true;
    state.sessionSecrets.freshdeskAuth = encodedAuth;
    refs.domain.value = domain;

    updateFreshdeskStatus();
    updateNotificationVisibility();
    showMessage(refs.freshdeskMessage, "Freshdesk verified.", "success");
  } catch (error) {
    console.error("Failed to verify Freshdesk credentials:", error);
    clearFreshdeskVerification();
    showMessage(refs.freshdeskMessage, "Could not verify Freshdesk. Check the domain and API key.", "error");
  }
}

function markTrelloAuthPending() {
  cleanupTrelloAuthFlow();
  state.trelloAuthInFlight = true;
  refs.connectTrelloBtn.disabled = true;

  state.trelloAuthTimeoutId = window.setTimeout(() => {
    cleanupTrelloAuthFlow();
    showMessage(refs.trelloMessage, "Trello sign-in timed out. Click Connect Trello to try again.", "error");
  }, TRELLO_AUTH_TIMEOUT_MS);
}

function openTrelloAuthPopup(url) {
  try {
    const popup = window.open(
      url,
      TRELLO_AUTH_POPUP_NAME,
      "width=720,height=760,menubar=no,toolbar=no,location=yes,resizable=yes,scrollbars=yes,status=no"
    );
    return Boolean(popup);
  } catch (error) {
    console.error("Failed to open Trello popup:", error);
    return false;
  }
}

function cleanupTrelloAuthFlow() {
  state.trelloAuthInFlight = false;
  refs.connectTrelloBtn.disabled = false;

  if (state.trelloAuthTimeoutId) {
    window.clearTimeout(state.trelloAuthTimeoutId);
    state.trelloAuthTimeoutId = null;
  }
}

function clearTrelloConnection(options) {
  const settings = options || {};

  cleanupTrelloAuthFlow();
  state.sessionSecrets.trelloToken = "";
  state.trelloVerified = false;
  state.connectedTrelloMember = null;

  if (settings.clearSavedConfigKey) {
    state.savedConfigs.trello_token = "";
  }

  updateTrelloStatus();
  updateNotificationVisibility();
}

function clearFreshdeskVerification() {
  state.freshdeskVerified = false;
  state.sessionSecrets.freshdeskAuth = "";
  updateFreshdeskStatus();
  updateNotificationVisibility();
}

function updateTrelloStatus() {
  refs.trelloStatusLine.textContent = state.trelloVerified
    ? state.connectedTrelloMember && state.connectedTrelloMember.name
      ? `Connected as ${state.connectedTrelloMember.name}`
      : "Connected"
    : "Not connected";

  const visible = state.trelloVerified && state.connectedTrelloMember;
  refs.trelloConnectionSummary.classList.toggle("is-visible", Boolean(visible));

  if (!visible) {
    refs.trelloMemberName.textContent = "No Trello account connected yet.";
    refs.trelloMemberMeta.textContent = "";
    return;
  }

  refs.trelloMemberName.textContent = state.connectedTrelloMember.name;

  const details = [];
  if (state.connectedTrelloMember.username) {
    details.push(`@${state.connectedTrelloMember.username}`);
  }
  if (state.connectedTrelloMember.url) {
    details.push(state.connectedTrelloMember.url);
  }

  refs.trelloMemberMeta.textContent = details.join(" • ");
}

function updateFreshdeskStatus() {
  refs.freshdeskStatusLine.textContent = state.freshdeskVerified ? "Verified" : "Not verified";
}

function updateNotificationVisibility() {
  const ready = state.trelloVerified && state.freshdeskVerified;
  refs.notificationSettingsSection.classList.toggle("hidden", !ready);
}

function renderNotificationSettings() {
  refs.trelloToFreshdeskList.innerHTML = buildNotificationRows(
    TRELLO_TO_FRESHDESK_EVENTS,
    state.notificationPreferences.trelloToFreshdesk,
    FRESHDESK_ACTION_OPTIONS,
    "trelloToFreshdesk"
  );
  refs.freshdeskToTrelloList.innerHTML = buildNotificationRows(
    FRESHDESK_TO_TRELLO_EVENTS,
    state.notificationPreferences.freshdeskToTrello,
    TRELLO_ACTION_OPTIONS,
    "freshdeskToTrello"
  );
}

function buildNotificationRows(events, selections, options, group) {
  return events
    .map((event) => {
      const value = selections && selections[event.key] ? selections[event.key] : options[0].value;
      return `
        <div class="notification-row">
          <div class="notification-label">${escapeHtml(event.label)}</div>
          <select class="notification-select" data-group="${escapeHtml(group)}" data-key="${escapeHtml(event.key)}">
            ${buildNotificationOptions(options, value)}
          </select>
        </div>
      `;
    })
    .join("");
}

function buildNotificationOptions(options, selectedValue) {
  return options
    .map((option) => {
      const selected = option.value === selectedValue ? " selected" : "";
      return `<option value="${escapeHtml(option.value)}"${selected}>${escapeHtml(option.label)}</option>`;
    })
    .join("");
}

function handleNotificationSelectionChange(event) {
  const select = event.target.closest("select[data-group][data-key]");
  if (!select) {
    return;
  }

  if (select.dataset.group === "trelloToFreshdesk") {
    state.notificationPreferences.trelloToFreshdesk[select.dataset.key] = select.value;
    return;
  }

  if (select.dataset.group === "freshdeskToTrello") {
    state.notificationPreferences.freshdeskToTrello[select.dataset.key] = select.value;
  }
}

function normalizeDomain(value) {
  const cleaned = String(value || "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (!cleaned) {
    return "";
  }
  return cleaned.includes(".") ? cleaned : `${cleaned}.freshdesk.com`;
}

function resolveTrelloToFreshdeskMode(configs) {
  const mode = String((configs && configs.trello_to_freshdesk_sync_mode) || "").trim().toLowerCase();
  if (["none", "private_note_notify", "public_note"].includes(mode)) {
    return mode;
  }
  return "none";
}

function resolveFreshdeskToTrelloMode(configs) {
  const mode = String((configs && configs.freshdesk_to_trello_sync_mode) || "").trim().toLowerCase();
  if (["none", "comment"].includes(mode)) {
    return mode;
  }
  return "none";
}

function normalizeNotificationPreferences(value, events, fallbackValue) {
  const parsed = safeParseJson(value, {});
  const output = {};

  events.forEach((event) => {
    const savedValue =
      parsed && typeof parsed === "object" && typeof parsed[event.key] === "string" ? parsed[event.key].trim() : "";
    output[event.key] = savedValue || fallbackValue;
  });

  return output;
}

function showMessage(element, message, type) {
  element.textContent = message;
  element.className = `message ${type}`;
}

function clearMessage(element) {
  element.textContent = "";
  element.className = "message";
}

function safeParseJson(value, fallback) {
  if (!value) {
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

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function postConfigs() {
  const trelloToken = getActiveTrelloToken();
  return {
    __meta: {
      secure: ["trello_token", "api_key"],
    },
    trello_api_key: getActiveTrelloApiKey(),
    trello_token: trelloToken,
    trello_token_fingerprint: buildTokenFingerprint(trelloToken),
    trello_token_saved_at: trelloToken ? new Date().toISOString() : "",
    trello_member_name: state.connectedTrelloMember ? state.connectedTrelloMember.name : "",
    trello_member_username: state.connectedTrelloMember ? state.connectedTrelloMember.username : "",
    trello_member_url: state.connectedTrelloMember ? state.connectedTrelloMember.url : "",
    domain: normalizeDomain(refs.domain.value),
    api_key: getActiveFreshdeskAuth(),
    trello_to_freshdesk_sync_mode: resolvePrimaryNotificationMode(state.notificationPreferences.trelloToFreshdesk),
    freshdesk_to_trello_sync_mode: resolvePrimaryNotificationMode(state.notificationPreferences.freshdeskToTrello),
    trello_to_freshdesk_notifications: state.notificationPreferences.trelloToFreshdesk,
    freshdesk_to_trello_notifications: state.notificationPreferences.freshdeskToTrello,
  };
}

function resolvePrimaryNotificationMode(group) {
  const values = Object.values(group || {}).filter(Boolean);
  return values.length ? values[0] : "none";
}

function getConfigs(configs) {
  state.savedConfigs = configs || {};
  if (state.initialized) {
    void hydrateFromConfigs(state.savedConfigs);
  }
}

async function validate() {
  await ensureInitialized();

  if (!getActiveTrelloApiKey()) {
    showMessage(refs.trelloMessage, "Trello is not configured for this app yet.", "error");
    return false;
  }

  if (!getActiveTrelloToken() || !state.trelloVerified) {
    showMessage(refs.trelloMessage, "Connect Trello before installing.", "error");
    return false;
  }

  if (!normalizeDomain(refs.domain.value)) {
    showMessage(refs.freshdeskMessage, "Freshdesk domain is required.", "error");
    return false;
  }

  if (!getActiveFreshdeskAuth() || !state.freshdeskVerified) {
    showMessage(refs.freshdeskMessage, "Verify Freshdesk before installing.", "error");
    return false;
  }

  return true;
}
