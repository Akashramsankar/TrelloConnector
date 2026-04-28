let client;

const EVENT_CONFIG = [
  { eventName: "ticket.statusChanged", fieldId: "status" },
  { eventName: "ticket.priorityChanged", fieldId: "priority" },
  { eventName: "ticket.typeChanged", fieldId: "ticket_type" },
  { eventName: "ticket.groupChanged", fieldId: "group" },
  { eventName: "ticket.agentChanged", fieldId: "agent" },
];

const DEPENDENT_EVENT_CONFIG = [
  { eventName: "ticket.categoryChanged", fieldId: "category", level: 1 },
  { eventName: "ticket.subCategoryChanged", fieldId: "sub_category", level: 2 },
  { eventName: "ticket.itemChanged", fieldId: "item", level: 3 },
];

const runtimeState = {
  rules: [],
  fieldCatalog: {},
  triggerFieldCatalog: {},
  lastConfigRefreshAt: 0,
  liveFieldOptions: {},
  currentValues: {
    status: null,
    priority: null,
    ticket_type: null,
    group: null,
    agent: null,
    source: null,
  },
  customFieldValues: {},
  fieldEventTimestamps: {},
  lastApplied: {},
  lastFailedOptions: {},
  optionPayloadPreferences: {},
  applyDebounceTimer: null,
  applyInFlight: false,
  applyQueued: false,
  applyWaiters: [],
  detailsRefreshTimer: null,
  detailsRefreshQueued: false,
  detailsRefreshWaiters: [],
  dependentReapplyTimers: [],
  dependentWatchdogTimer: null,
  isDetailsPage: false,
  refreshingDetails: false,
};

const RUNTIME_CACHE_KEY = "dhp_runtime_cache_v3";
const CONFIG_REFRESH_INTERVAL_MS = 5000;
const APPLY_RULES_DEBOUNCE_MS = 80;
const DETAILS_REFRESH_DEBOUNCE_MS = 120;
const RECENT_EVENT_VALUE_GRACE_MS = 2000;
const FAILED_PAYLOAD_RETRY_COOLDOWN_MS = 1500;
const DEPENDENT_REAPPLY_DELAYS_MS = [250, 750, 1500];
const DEPENDENT_POST_APPLY_RETRY_DELAYS_MS = [200, 700];
const DEBUG_STORAGE_KEY = "dhp_debug";
const DEBUG_NAMESPACE = "[Dropdown Hider Pro]";
const DEBUG_HISTORY_LIMIT = 200;
const DEPENDENT_PATH_VALUE_PREFIX = "__dhp_path__:";

document.addEventListener("DOMContentLoaded", initRuntime);

async function initRuntime() {
  try {
    debugLog("init:start");
    client = await app.initialized();
    await detectContext();

    const cached = loadCachedRuntimeData();
    if (cached) {
      runtimeState.rules = cached.rules;
      runtimeState.fieldCatalog = cached.field_catalog;
      runtimeState.triggerFieldCatalog = cached.trigger_field_catalog || {};
      runtimeState.liveFieldOptions = {};
      debugLog("init:cached-runtime-loaded", {
        rules: runtimeState.rules.length,
        fields: Object.keys(runtimeState.fieldCatalog).length,
      });
      await requestApplyRules("init:cached-runtime", { immediate: true });
    }

    await refreshRuntimeConfig(true);
    bindRuntimeEvents();
    await requestApplyRules("init:fresh-runtime", { immediate: true });
    cacheRuntimeData();
    debugLog("init:complete", {
      isDetailsPage: runtimeState.isDetailsPage,
      rules: runtimeState.rules.length,
    });
  } catch (error) {
    debugLog("init:error", { message: error && error.message });
    console.error("Failed to initialize Dropdown Hider Pro runtime:", error);
  }
}

function loadCachedRuntimeData() {
  try {
    const raw = localStorage.getItem(RUNTIME_CACHE_KEY);
    if (!raw) {
      return null;
    }
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.rules) && data.field_catalog) {
      return data;
    }
    return null;
  } catch {
    return null;
  }
}

function cacheRuntimeData() {
  try {
    localStorage.setItem(RUNTIME_CACHE_KEY, JSON.stringify({
      rules: runtimeState.rules,
      field_catalog: runtimeState.fieldCatalog,
      trigger_field_catalog: runtimeState.triggerFieldCatalog,
    }));
  } catch {
    // Storage may be unavailable; ignore silently.
  }
}

function bindRuntimeEvents() {
  bindRuntimeEvent("app.activated", async () => {
    debugLog("event:app.activated");
    await refreshRuntimeConfig(true);
    if (runtimeState.isDetailsPage) {
      await requestTicketDetailsRefresh("event:app.activated", { immediate: true });
    }
    await requestApplyRules("event:app.activated", { immediate: true });
    cacheRuntimeData();
  });

  EVENT_CONFIG.forEach((config) => {
    bindRuntimeEvent(config.eventName, async (payload) => {
      debugLog("event:field-changed", {
        eventName: config.eventName,
        fieldId: config.fieldId,
      });
      await refreshRuntimeConfig(true);
      await updateValueFromEvent(config.fieldId, payload);
      if (runtimeState.isDetailsPage) {
        await requestTicketDetailsRefresh(`${config.eventName}:details`);
      }
      await requestApplyRules(`event:${config.eventName}`);
      scheduleDependentReapply(`event:${config.eventName}`);
    });
  });

  DEPENDENT_EVENT_CONFIG.forEach((config) => {
    bindRuntimeEvent(config.eventName, async (payload) => {
      debugLog("event:dependent-field-changed", {
        eventName: config.eventName,
        fieldId: config.fieldId,
      });
      logDependentTrace("dependent-field-changed", {
        eventName: config.eventName,
        fieldId: config.fieldId,
      });
      await refreshRuntimeConfig(true);
      await updateValueFromEvent(config.fieldId, payload);
      if (runtimeState.isDetailsPage) {
        await requestTicketDetailsRefresh(`${config.eventName}:details`);
      }
      await requestApplyRules(`event:${config.eventName}`, { immediate: true });
      scheduleDependentReapply(`event:${config.eventName}`);
    });
  });

  if (runtimeState.isDetailsPage) {
    bindRuntimeEvent("ticket.propertiesUpdated", async () => {
      debugLog("event:ticket.propertiesUpdated");
      await refreshRuntimeConfig(true);
      await requestTicketDetailsRefresh("event:ticket.propertiesUpdated");
      await requestApplyRules("event:ticket.propertiesUpdated");
    });
  }
}

function bindRuntimeEvent(eventName, handler) {
  try {
    client.events.on(eventName, handler);
  } catch (error) {
    debugLog("event:bind-failed", {
      eventName,
      message: error && error.message,
    });
  }
}

async function loadRuntimeData() {
  const response = await client.request.invoke("getDropdownHiderRuntimeData", {});
  const payload = parseInvokeResponse(response);

  if (!payload || payload.success === false) {
    throw new Error(resolveInvokeError(payload) || "Unable to load runtime data.");
  }

  runtimeState.rules = Array.isArray(payload.rules) ? payload.rules : [];
  runtimeState.fieldCatalog = payload.field_catalog || {};
  runtimeState.triggerFieldCatalog = payload.trigger_field_catalog || {};
  runtimeState.liveFieldOptions = {};
  runtimeState.lastFailedOptions = {};
  runtimeState.optionPayloadPreferences = {};
  runtimeState.lastConfigRefreshAt = Date.now();
  debugLog("runtime-data:loaded", {
    rules: runtimeState.rules.length,
    fieldCatalogKeys: Object.keys(runtimeState.fieldCatalog),
    triggerFieldKeys: Object.keys(runtimeState.triggerFieldCatalog),
  });
}

async function refreshRuntimeConfig(force) {
  const shouldForce = Boolean(force);
  const now = Date.now();

  if (!shouldForce && now - runtimeState.lastConfigRefreshAt < CONFIG_REFRESH_INTERVAL_MS) {
    return;
  }

  await loadRuntimeData();
}

async function detectContext() {
  try {
    const result = await client.data.get("ticket");
    const ticket = result && result.ticket ? result.ticket : result;
    if (ticket && typeof ticket === "object") {
      runtimeState.isDetailsPage = true;
      updateTicketSnapshot(ticket);
      debugLog("context:details-page-detected");
      return;
    }
  } catch {
    runtimeState.isDetailsPage = false;
  }

  debugLog("context:new-ticket-page-detected");
}

function requestTicketDetailsRefresh(reason, options) {
  if (!runtimeState.isDetailsPage) {
    return Promise.resolve();
  }

  const immediate = Boolean(options && options.immediate);

  return new Promise((resolve) => {
    runtimeState.detailsRefreshWaiters.push(resolve);
    runtimeState.detailsRefreshQueued = true;

    if (runtimeState.detailsRefreshTimer) {
      window.clearTimeout(runtimeState.detailsRefreshTimer);
      runtimeState.detailsRefreshTimer = null;
    }

    const delay = immediate ? 0 : DETAILS_REFRESH_DEBOUNCE_MS;
    debugLog("ticket:details-refresh-requested", { reason, immediate, delay });

    runtimeState.detailsRefreshTimer = window.setTimeout(() => {
      runtimeState.detailsRefreshTimer = null;
      void flushTicketDetailsRefresh(reason);
    }, delay);
  });
}

async function flushTicketDetailsRefresh(reason) {
  if (runtimeState.refreshingDetails) {
    debugLog("ticket:details-refresh-deferred", { reason });
    return;
  }

  runtimeState.refreshingDetails = true;
  runtimeState.detailsRefreshQueued = false;
  const waiters = runtimeState.detailsRefreshWaiters.splice(0);

  try {
    debugLog("ticket:details-refresh-start", { reason });
    await performTicketDetailsRefresh();
    waiters.forEach((resolve) => resolve());
    debugLog("ticket:details-refresh-complete", { reason });
  } catch (error) {
    waiters.forEach((resolve) => resolve());
    debugLog("ticket:details-refresh-failed", { message: error && error.message });
    console.error("Unable to refresh ticket details:", error);
  } finally {
    runtimeState.refreshingDetails = false;

    if (runtimeState.detailsRefreshQueued) {
      debugLog("ticket:details-refresh-requeued", { reason });
      void requestTicketDetailsRefresh("ticket:details-refresh-requeued", { immediate: true });
    }
  }
}

async function performTicketDetailsRefresh() {
  const result = await client.data.get("ticket");
  const ticket = result && result.ticket ? result.ticket : result;
  if (ticket && typeof ticket === "object") {
    updateTicketSnapshot(ticket);
    debugLog("ticket:details-refreshed", {
      currentValues: runtimeState.currentValues,
    });
  }
}

function updateTicketSnapshot(ticket) {
  updateCurrentValueFromSnapshot("status", extractObjectValue("status", ticket));
  updateCurrentValueFromSnapshot("priority", extractObjectValue("priority", ticket));
  updateCurrentValueFromSnapshot("ticket_type", extractObjectValue("ticket_type", ticket));
  updateCurrentValueFromSnapshot("group", extractObjectValue("group", ticket));
  updateCurrentValueFromSnapshot("agent", extractObjectValue("agent", ticket));
  updateCurrentValueFromSnapshot("source", extractObjectValue("source", ticket));
  runtimeState.customFieldValues = normalizeCustomFields(ticket.custom_fields || ticket.customFields || {});
  debugLog("ticket:snapshot-updated", {
    currentValues: runtimeState.currentValues,
    customFieldKeys: Object.keys(runtimeState.customFieldValues || {}),
  });
}

async function updateValueFromEvent(fieldId, payload) {
  const value = await extractEventValue(fieldId, payload);
  if (value !== null) {
    runtimeState.currentValues[fieldId] = normalizeTriggerValue(fieldId, value);
    runtimeState.fieldEventTimestamps[fieldId] = Date.now();
    debugLog("ticket:event-value-updated", {
      fieldId,
      rawValue: value,
      normalizedValue: runtimeState.currentValues[fieldId],
    });
  }
}

function updateCurrentValueFromSnapshot(fieldId, rawValue) {
  const normalizedValue = normalizeTriggerValue(fieldId, rawValue);
  const lastEventTimestamp = runtimeState.fieldEventTimestamps[fieldId] || 0;
  const shouldPreserveEventValue =
    lastEventTimestamp &&
    Date.now() - lastEventTimestamp < RECENT_EVENT_VALUE_GRACE_MS &&
    runtimeState.currentValues[fieldId] !== null &&
    runtimeState.currentValues[fieldId] !== undefined &&
    runtimeState.currentValues[fieldId] !== "";

  if (shouldPreserveEventValue) {
    debugLog("ticket:snapshot-value-skipped", {
      fieldId,
      snapshotValue: normalizedValue,
      eventValue: runtimeState.currentValues[fieldId],
      lastEventTimestamp,
    });
    return;
  }

  runtimeState.currentValues[fieldId] = normalizedValue;
}

async function extractEventValue(fieldId, payload) {
  const source = payload && payload.helper && typeof payload.helper.getData === "function"
    ? await payload.helper.getData()
    : payload;

  return extractObjectValue(fieldId, source);
}

function requestApplyRules(reason, options) {
  const immediate = Boolean(options && options.immediate);

  return new Promise((resolve) => {
    runtimeState.applyWaiters.push(resolve);
    runtimeState.applyQueued = true;

    if (runtimeState.applyDebounceTimer) {
      window.clearTimeout(runtimeState.applyDebounceTimer);
      runtimeState.applyDebounceTimer = null;
    }

    const delay = immediate ? 0 : APPLY_RULES_DEBOUNCE_MS;
    debugLog("rules:apply-requested", { reason, immediate, delay });

    runtimeState.applyDebounceTimer = window.setTimeout(() => {
      runtimeState.applyDebounceTimer = null;
      void flushApplyRules(reason);
    }, delay);
  });
}

function scheduleDependentReapply(reason) {
  runtimeState.dependentReapplyTimers.forEach((timer) => window.clearTimeout(timer));
  runtimeState.dependentReapplyTimers = [];

  if (!hasActiveDependentRules()) {
    return;
  }

  if (!hasDependentTargetsAfterChangedLevel(reason)) {
    logDependentTrace("scheduled-reapply-skipped", {
      reason,
      changedLevel: getDependentChangedLevelFromReason(reason),
    });
    return;
  }

  DEPENDENT_REAPPLY_DELAYS_MS.forEach((delay) => {
    const timer = window.setTimeout(() => {
      runtimeState.dependentReapplyTimers = runtimeState.dependentReapplyTimers
        .filter((item) => item !== timer);
      logDependentTrace("scheduled-reapply", {
        reason,
        delay,
      });
      void requestApplyRules(`${reason}:dependent-reapply:${delay}`, { immediate: true });
    }, delay);

    runtimeState.dependentReapplyTimers.push(timer);
  });
}

function hasActiveDependentRules() {
  return (Array.isArray(runtimeState.rules) ? runtimeState.rules : [])
    .some((rule) => rule && rule.kind === "dependent" && rule.active !== false);
}

function shouldForceDependentSetOptions(reason) {
  const normalizedReason = String(reason || "");
  return (
    normalizedReason.includes(":dependent-reapply:") ||
    DEPENDENT_EVENT_CONFIG.some((config) => normalizedReason.includes(config.eventName))
  );
}

function updateDependentWatchdog(hiddenMap, reason) {
  if (runtimeState.dependentWatchdogTimer) {
    window.clearInterval(runtimeState.dependentWatchdogTimer);
    runtimeState.dependentWatchdogTimer = null;
    logDependentTrace("watchdog-stopped", { reason });
  }
}

function hasDependentTargetsAfterChangedLevel(reason) {
  const changedLevel = getDependentChangedLevelFromReason(reason);
  if (!changedLevel) {
    return true;
  }

  return (Array.isArray(runtimeState.rules) ? runtimeState.rules : []).some((rule) => (
    rule &&
    rule.kind === "dependent" &&
    rule.active !== false &&
    (rule.hidden_selections || []).some((selection) => {
      const fieldMeta = runtimeState.fieldCatalog[selection && selection.field_name];
      return (
        isDependentHierarchyField(fieldMeta) &&
        getDependentFieldLevel(selection.field_name, fieldMeta) > changedLevel
      );
    })
  ));
}

function getDependentChangedLevelFromReason(reason) {
  const normalizedReason = String(reason || "");
  const matchedConfig = DEPENDENT_EVENT_CONFIG.find((config) => normalizedReason.includes(config.eventName));
  return matchedConfig ? Number(matchedConfig.level || 0) : 0;
}

function getDependentFieldLevel(fieldName, fieldMeta) {
  const explicitLevel = Number(fieldMeta && fieldMeta.level);
  if (explicitLevel) {
    return explicitLevel;
  }

  const levels = Array.isArray(fieldMeta && fieldMeta.root_levels)
    ? fieldMeta.root_levels
    : [];
  const index = levels.findIndex((level) => level && level.name === fieldName);
  return index === -1 ? 0 : index + 1;
}

function shouldSkipDependentTargetForReason(reason, fieldName, fieldMeta) {
  const changedLevel = getDependentChangedLevelFromReason(reason);
  if (!changedLevel || !isDependentHierarchyField(fieldMeta)) {
    return false;
  }

  return getDependentFieldLevel(fieldName, fieldMeta) <= changedLevel;
}

async function flushApplyRules(reason) {
  if (runtimeState.applyInFlight) {
    debugLog("rules:apply-flush-deferred", { reason });
    return;
  }

  runtimeState.applyInFlight = true;
  runtimeState.applyQueued = false;
  const waiters = runtimeState.applyWaiters.splice(0);

  try {
    debugLog("rules:apply-flush-start", { reason });
    await applyRules(reason);
    waiters.forEach((resolve) => resolve());
    debugLog("rules:apply-flush-complete", { reason });
  } catch (error) {
    debugLog("rules:apply-flush-failed", {
      reason,
      message: error && error.message,
    });
    waiters.forEach((resolve) => resolve());
  } finally {
    runtimeState.applyInFlight = false;

    if (runtimeState.applyQueued) {
      debugLog("rules:apply-requeued", { reason });
      void requestApplyRules("flush:requeued", { immediate: true });
    }
  }
}

async function applyRules(reason) {
  const evaluations = evaluateRules();
  const hiddenMap = buildHiddenMap(evaluations);
  const targetFieldNames = new Set(Object.keys(runtimeState.lastApplied || {}));

  evaluations.forEach((evaluation) => {
    const rule = evaluation && evaluation.rule;
    if (!rule) {
      return;
    }

    if (rule.kind === "dependent") {
      addDependentRuleTargetFields(rule, targetFieldNames, evaluation.matched);
      return;
    }

    (rule.hidden_selections || []).forEach((selection) => {
      if (
        selection.field_name &&
        (evaluation.matched || runtimeState.lastApplied[selection.field_name])
      ) {
        targetFieldNames.add(selection.field_name);
      }
    });
  });

  const tasks = [];
  const fieldOutcomes = [];
  debugLog("rules:apply-start", {
    reason,
    hiddenMap,
    targetFields: Array.from(targetFieldNames),
  });
  logDependentTrace("rules-evaluated", {
    reason,
    rules: summarizeDependentEvaluations(evaluations),
    hiddenMap,
    targetFields: Array.from(targetFieldNames),
    currentValues: runtimeState.currentValues,
    customFieldValues: runtimeState.customFieldValues,
  });
  logDependentConditionMatches(reason, evaluations, hiddenMap);

  for (const fieldName of targetFieldNames) {
    const fieldMeta = runtimeState.fieldCatalog[fieldName];
    if (!fieldMeta || !fieldMeta.element_id) {
      fieldOutcomes.push({
        fieldName,
        status: "missing-meta",
      });
      continue;
    }

    if (shouldSkipDependentTargetForReason(reason, fieldName, fieldMeta)) {
      logDependentTrace("target-skipped-for-dependent-level", {
        reason,
        fieldName,
        elementId: fieldMeta.element_id,
        targetLevel: getDependentFieldLevel(fieldName, fieldMeta),
        changedLevel: getDependentChangedLevelFromReason(reason),
      });
      fieldOutcomes.push({
        fieldName,
        status: "skipped-dependent-level",
      });
      continue;
    }

    if (isDependentRootField(fieldName, fieldMeta)) {
      const hiddenValues = hiddenMap[fieldName] || [];
      const payloadCandidates = buildDependentOptionPayloadCandidates(fieldMeta, hiddenMap);
      const nextOptions = payloadCandidates[0] ? payloadCandidates[0].values : [];
      const nextOptionsKey = serializeOptions(nextOptions);
      const forceSetOptions = shouldForceDependentSetOptions(reason);
      logDependentTrace("root-payload-built", {
        reason,
        fieldName,
        elementId: fieldMeta.element_id,
        hiddenValues,
        hiddenMap,
        forceSetOptions,
        payloadCandidates: summarizePayloadCandidates(payloadCandidates),
      });

      if (!forceSetOptions && arraysMatch(runtimeState.lastApplied[fieldName], nextOptions)) {
        debugLog("rules:apply-skip-unchanged", { fieldName, nextOptions });
        logDependentTrace("payload-skipped-unchanged", {
          reason,
          fieldName,
          elementId: fieldMeta.element_id,
          nextOptions,
          hiddenValues,
          lastApplied: runtimeState.lastApplied[fieldName],
        });
        fieldOutcomes.push({
          fieldName,
          status: "unchanged",
          hiddenValues,
        });
        continue;
      }

      if (shouldSkipFailedPayload(fieldName, nextOptionsKey)) {
        debugLog("rules:apply-skip-failed-payload", {
          fieldName,
          nextOptions,
          retryAfterMs: getFailedPayloadRetryAfter(fieldName),
        });
        logDependentTrace("payload-skipped-recent-failure", {
          reason,
          fieldName,
          elementId: fieldMeta.element_id,
          nextOptions,
          retryAfterMs: getFailedPayloadRetryAfter(fieldName),
        }, "warn");
        fieldOutcomes.push({
          fieldName,
          status: "skipped-failed-payload",
          hiddenValues,
          options: nextOptions,
        });
        continue;
      }

      tasks.push(
        applyFieldOptions(fieldName, fieldMeta, payloadCandidates, hiddenValues).then((result) => {
          fieldOutcomes.push(result);
        })
      );
      continue;
    }

    const availableOptions = await resolveAvailableOptions(fieldName, fieldMeta, hiddenMap);
    if (!availableOptions.length && !isDependentHierarchyField(fieldMeta)) {
      fieldOutcomes.push({
        fieldName,
        status: "no-options",
      });
      continue;
    }

    const hiddenValues = hiddenMap[fieldName] || [];
    const currentValue = runtimeState.currentValues[fieldName];
    const filteredOptions = availableOptions
      .filter((option) => {
        const shouldHide = hiddenValues.some((hiddenValue) => optionMatchesHiddenValue(fieldMeta, option, hiddenValue));
        if (!shouldHide) {
          return true;
        }

        // Freshdesk rejects status payloads when the currently selected value disappears.
        if (fieldMeta.element_id === "status" && optionMatchesCurrentValue(fieldMeta, option, currentValue)) {
          debugLog("field:status-option-preserved", {
            fieldName,
            currentValue,
            option,
          });
          return true;
        }

        return false;
      });
    const payloadCandidates = isDependentHierarchyField(fieldMeta)
      ? buildDependentChildOptionPayloadCandidates(fieldName, fieldMeta, filteredOptions, hiddenMap)
      : buildOptionPayloadCandidates(fieldName, fieldMeta, filteredOptions);
    const nextOptions = payloadCandidates[0] ? payloadCandidates[0].values : [];
    const nextOptionsKey = serializeOptions(nextOptions);
    const forceSetOptions = isDependentHierarchyField(fieldMeta) && shouldForceDependentSetOptions(reason);

    if (isDependentHierarchyField(fieldMeta)) {
      logDependentTrace("child-payload-built", {
        reason,
        fieldName,
        elementId: fieldMeta.element_id,
        rootName: fieldMeta.root_name,
        hiddenValues,
        hiddenMap,
        forceSetOptions,
        availableOptions: summarizeOptionsForConsole(availableOptions),
        filteredOptions: summarizeOptionsForConsole(filteredOptions),
        payloadCandidates: summarizePayloadCandidates(payloadCandidates),
      });
    }

    logStatusConsole("payload-built", {
      fieldName,
      currentValue,
      hiddenValues,
      availableOptions: summarizeOptionsForConsole(availableOptions),
      filteredOptions: summarizeOptionsForConsole(filteredOptions),
      payloadCandidates,
    }, fieldMeta);

    if (!forceSetOptions && arraysMatch(runtimeState.lastApplied[fieldName], nextOptions)) {
      debugLog("rules:apply-skip-unchanged", { fieldName, nextOptions });
      if (isDependentHierarchyField(fieldMeta)) {
        logDependentTrace("payload-skipped-unchanged", {
          reason,
          fieldName,
          elementId: fieldMeta.element_id,
          nextOptions,
          hiddenValues,
          lastApplied: runtimeState.lastApplied[fieldName],
        });
      }
      fieldOutcomes.push({
        fieldName,
        status: "unchanged",
        hiddenValues,
      });
      continue;
    }

    if (shouldSkipFailedPayload(fieldName, nextOptionsKey)) {
      debugLog("rules:apply-skip-failed-payload", {
        fieldName,
        nextOptions,
        retryAfterMs: getFailedPayloadRetryAfter(fieldName),
      });
      if (isDependentHierarchyField(fieldMeta)) {
        logDependentTrace("payload-skipped-recent-failure", {
          reason,
          fieldName,
          elementId: fieldMeta.element_id,
          nextOptions,
          retryAfterMs: getFailedPayloadRetryAfter(fieldName),
        }, "warn");
      }
      fieldOutcomes.push({
        fieldName,
        status: "skipped-failed-payload",
        hiddenValues,
        options: nextOptions,
      });
      continue;
    }

    tasks.push(
      applyFieldOptions(fieldName, fieldMeta, payloadCandidates, hiddenValues).then((result) => {
        fieldOutcomes.push(result);
      })
    );
  }

  await Promise.all(tasks);
  updateDependentWatchdog(hiddenMap, reason);
  reportApplyOutcome(reason, evaluations, hiddenMap, fieldOutcomes);
  debugLog("rules:apply-complete", {
    reason,
    appliedFields: Object.keys(runtimeState.lastApplied),
    fieldOutcomes,
  });
}

function isDependentHierarchyField(fieldMeta) {
  return Boolean(
    fieldMeta &&
      Array.isArray(fieldMeta.root_choice_tree) &&
      fieldMeta.root_choice_tree.length &&
      Array.isArray(fieldMeta.root_levels) &&
      fieldMeta.root_levels.length
  );
}

function isDependentRootField(fieldName, fieldMeta) {
  return Boolean(
    isDependentHierarchyField(fieldMeta) &&
      (!fieldMeta.root_name || fieldMeta.root_name === fieldName)
  );
}

function addDependentRuleTargetFields(rule, targetFieldNames, shouldApplyRule) {
  if (!rule || rule.kind !== "dependent" || !rule.target_root_name) {
    return;
  }

  (rule.hidden_selections || []).forEach((selection) => {
    const fieldName = selection && selection.field_name;
    if (!fieldName) {
      return;
    }

    if (shouldApplyRule || runtimeState.lastApplied[fieldName]) {
      targetFieldNames.add(fieldName);
    }
  });
}

function evaluateRules() {
  return runtimeState.rules.map((rule) => {
    const conditionOperator = normalizeConditionOperator(rule && rule.condition_operator);
    const active = rule.active !== false;
    const conditionResult = active
      ? evaluateConditions(rule.conditions, rule, conditionOperator)
      : {
        matched: false,
        hasConditions: Array.isArray(rule.conditions) && rule.conditions.length > 0,
        conditions: [],
        operator: conditionOperator,
      };

    debugLog("rule:evaluated", {
      ruleId: rule.id,
      ruleName: rule.name,
      active,
      conditionOperator,
      matched: active && conditionResult.matched,
    });

    return {
      rule,
      active,
      conditionOperator,
      matched: active && conditionResult.matched,
      hasConditions: conditionResult.hasConditions,
      conditions: conditionResult.conditions,
    };
  });
}

function buildHiddenMap(evaluations) {
  const hiddenMap = {};

  (Array.isArray(evaluations) ? evaluations : []).forEach((evaluation) => {
    if (!evaluation || !evaluation.matched || !evaluation.rule) {
      return;
    }

    (evaluation.rule.hidden_selections || []).forEach((selection) => {
      if (!selection.field_name) {
        return;
      }

      if (!hiddenMap[selection.field_name]) {
        hiddenMap[selection.field_name] = [];
      }

      (selection.hidden_values || []).forEach((value) => {
        if (!hiddenMap[selection.field_name].some((item) => normalizeValue(item) === normalizeValue(value))) {
          hiddenMap[selection.field_name].push(value);
        }
      });
    });
  });

  debugLog("rules:hidden-map-built", hiddenMap);
  return hiddenMap;
}

function evaluateConditions(conditions, rule, operator) {
  const normalizedOperator = normalizeConditionOperator(operator);
  if (!Array.isArray(conditions) || !conditions.length) {
    debugLog("rule:conditions-none", {
      ruleId: rule && rule.id,
      ruleName: rule && rule.name,
      operator: normalizedOperator,
    });
    return {
      matched: true,
      hasConditions: false,
      operator: normalizedOperator,
      conditions: [],
    };
  }

  const evaluatedConditions = conditions.map((condition) => {
    let currentValue = runtimeState.currentValues[condition.field];
    if (currentValue === null || currentValue === undefined || currentValue === "") {
      currentValue = normalizeTriggerValue(
        condition.field,
        extractObjectValue(condition.field, runtimeState.customFieldValues[condition.field])
      );
    }
    if (currentValue === null || currentValue === "") {
      debugLog("rule:condition-miss-empty", {
        ruleId: rule && rule.id,
        field: condition.field,
        operator: normalizedOperator,
        expected: condition.values || [],
      });
      return {
        field: condition.field,
        expected: condition.values || [],
        currentValue,
        matched: false,
        reason: "empty-current-value",
      };
    }

    const matched = (condition.values || []).some(
      (value) => normalizeValue(value) === normalizeValue(currentValue)
    );

    debugLog("rule:condition-evaluated", {
      ruleId: rule && rule.id,
      field: condition.field,
      operator: normalizedOperator,
      expected: condition.values || [],
      currentValue,
      matched,
    });

    return {
      field: condition.field,
      expected: condition.values || [],
      currentValue,
      matched,
      reason: matched ? "matched" : "value-mismatch",
    };
  });

  return {
    matched: normalizedOperator === "or"
      ? evaluatedConditions.some((condition) => condition.matched)
      : evaluatedConditions.every((condition) => condition.matched),
    hasConditions: true,
    operator: normalizedOperator,
    conditions: evaluatedConditions,
  };
}

async function applyFieldOptions(fieldName, fieldMeta, payloadCandidates, hiddenValues) {
  const candidates = Array.isArray(payloadCandidates) && payloadCandidates.length
    ? payloadCandidates
    : [{ strategy: "submitValue", values: [] }];
  let lastError = null;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const options = Array.isArray(candidate && candidate.values) ? candidate.values : [];
    const strategy = candidate && candidate.strategy ? candidate.strategy : "submitValue";
    const elementId = candidate && candidate.id ? candidate.id : fieldMeta.element_id;
    const requestPayload = {
      id: elementId,
      value: options,
    };

    try {
      debugLog("field:set-options-attempt", {
        fieldName,
        elementId,
        strategy,
        attempt: index + 1,
        options,
        hiddenValues,
      });
      if (isDependentHierarchyField(fieldMeta)) {
        logDependentTrace("set-options-attempt", {
          fieldName,
          elementId,
          rootName: fieldMeta.root_name,
          strategy,
          attempt: index + 1,
          hiddenValues,
          requestPayload,
        });
      }
      logStatusConsole("set-options-attempt", {
        fieldName,
        strategy,
        attempt: index + 1,
        options,
        hiddenValues,
      }, fieldMeta);
      const response = await client.interface.trigger("setOptions", requestPayload);
      const postApplyResults = await runPostSetOptionsPayloads(candidate, fieldName, fieldMeta, hiddenValues);

      runtimeState.lastApplied[fieldName] = [...options];
      runtimeState.optionPayloadPreferences[fieldName] = strategy;
      delete runtimeState.lastFailedOptions[fieldName];
      debugLog("field:set-options-success", {
        fieldName,
        strategy,
        options,
      });
      if (isDependentHierarchyField(fieldMeta)) {
        logDependentTrace("set-options-success", {
          fieldName,
          elementId,
          rootName: fieldMeta.root_name,
          strategy,
          attempt: index + 1,
          hiddenValues,
          requestPayload,
          postApplyResults,
          response,
        });
      }
      logStatusConsole("set-options-success", {
        fieldName,
        strategy,
        options,
      }, fieldMeta);

      const currentValue = runtimeState.customFieldValues[fieldName];
      if (
        runtimeState.isDetailsPage &&
        currentValue &&
        hiddenValues.some((value) => hiddenValueMatchesCurrentFieldValue(value, currentValue))
      ) {
        debugLog("field:set-value-clear", {
          fieldName,
          elementId: fieldMeta.element_id,
          currentValue,
        });
        await client.interface.trigger("setValue", {
          id: fieldMeta.element_id,
          value: "",
        });
      }

      return {
        fieldName,
        status: "applied",
        hiddenValues,
        options,
        strategy,
        postApplyResults,
      };
    } catch (error) {
      lastError = error;
      debugLog("field:set-options-attempt-failed", {
        fieldName,
        elementId,
        strategy,
        attempt: index + 1,
        options,
        message: error && error.message,
      });
      if (isDependentHierarchyField(fieldMeta)) {
        logDependentTrace("set-options-attempt-failed", {
          fieldName,
          elementId,
          rootName: fieldMeta.root_name,
          strategy,
          attempt: index + 1,
          hiddenValues,
          requestPayload,
          message: error && error.message,
          error,
        }, "warn");
      }
      logStatusConsole("set-options-attempt-failed", {
        fieldName,
        strategy,
        attempt: index + 1,
        options,
        hiddenValues,
        message: error && error.message,
        error,
      }, fieldMeta, "warn");
    }
  }

  const primaryOptions = candidates[0] ? candidates[0].values : [];
  runtimeState.lastFailedOptions[fieldName] = {
    key: serializeOptions(primaryOptions),
    failedAt: Date.now(),
  };
  debugLog("field:set-options-failed", {
    fieldName,
    elementId: fieldMeta.element_id,
    payloadCandidates: candidates,
    message: lastError && lastError.message,
    error: lastError,
  });
  if (isDependentHierarchyField(fieldMeta)) {
    logDependentTrace("set-options-failed", {
      fieldName,
      elementId: fieldMeta.element_id,
      rootName: fieldMeta.root_name,
      payloadCandidates: summarizePayloadCandidates(candidates),
      hiddenValues,
      message: lastError && lastError.message,
      error: lastError,
    }, "error");
  }
  logStatusConsole("set-options-failed", {
    fieldName,
    payloadCandidates: candidates,
    hiddenValues,
    message: lastError && lastError.message,
    error: lastError,
  }, fieldMeta, "error");
  console.error(`Unable to update options for ${fieldName}:`, lastError);
  return {
    fieldName,
    status: "failed",
    hiddenValues,
    options: primaryOptions,
    payloadCandidates: candidates.map((candidate) => ({
      strategy: candidate.strategy,
      options: candidate.values,
    })),
    message: lastError && lastError.message,
  };
}

async function runPostSetOptionsPayloads(candidate, fieldName, fieldMeta, hiddenValues) {
  const postPayloads = Array.isArray(candidate && candidate.postApplyPayloads)
    ? candidate.postApplyPayloads
    : [];

  if (!postPayloads.length) {
    return [];
  }

  const results = [];

  for (let index = 0; index < postPayloads.length; index += 1) {
    const postPayload = postPayloads[index];
    const requestPayload = {
      id: postPayload.id,
      value: Array.isArray(postPayload.values) ? postPayload.values : [],
    };

    try {
      logDependentTrace("post-set-options-attempt", {
        fieldName,
        elementId: fieldMeta && fieldMeta.element_id,
        rootName: fieldMeta && fieldMeta.root_name,
        strategy: postPayload.strategy,
        attempt: index + 1,
        hiddenValues,
        requestPayload,
      });

      const response = await client.interface.trigger("setOptions", requestPayload);
      results.push({
        strategy: postPayload.strategy,
        status: "applied",
        requestPayload,
        response,
      });
      schedulePostSetOptionsRetries(postPayload, fieldName, fieldMeta, hiddenValues);

      logDependentTrace("post-set-options-success", {
        fieldName,
        strategy: postPayload.strategy,
        attempt: index + 1,
        requestPayload,
        response,
      });
      break;
    } catch (error) {
      results.push({
        strategy: postPayload.strategy,
        status: "failed",
        requestPayload,
        message: error && error.message,
      });

      logDependentTrace("post-set-options-failed", {
        fieldName,
        strategy: postPayload.strategy,
        attempt: index + 1,
        requestPayload,
        message: error && error.message,
        error,
      }, "warn");
    }
  }

  return results;
}

function schedulePostSetOptionsRetries(postPayload, fieldName, fieldMeta, hiddenValues) {
  DEPENDENT_POST_APPLY_RETRY_DELAYS_MS.forEach((delay) => {
    window.setTimeout(async () => {
      const requestPayload = {
        id: postPayload.id,
        value: Array.isArray(postPayload.values) ? postPayload.values : [],
      };

      try {
        logDependentTrace("post-set-options-retry-attempt", {
          fieldName,
          elementId: fieldMeta && fieldMeta.element_id,
          rootName: fieldMeta && fieldMeta.root_name,
          strategy: postPayload.strategy,
          delay,
          hiddenValues,
          requestPayload,
        });
        const response = await client.interface.trigger("setOptions", requestPayload);
        logDependentTrace("post-set-options-retry-success", {
          fieldName,
          strategy: postPayload.strategy,
          delay,
          requestPayload,
          response,
        });
      } catch (error) {
        logDependentTrace("post-set-options-retry-failed", {
          fieldName,
          strategy: postPayload.strategy,
          delay,
          requestPayload,
          message: error && error.message,
          error,
        }, "warn");
      }
    }, delay);
  });
}

function reportApplyOutcome(reason, evaluations, hiddenMap, fieldOutcomes) {
  if (!shouldLogConditionFailure(reason)) {
    return;
  }

  const relatedRules = (Array.isArray(evaluations) ? evaluations : []).filter((evaluation) => {
    if (!evaluation || !evaluation.active || !evaluation.hasConditions) {
      return false;
    }

    return reason === "event:ticket.propertiesUpdated" ||
      evaluation.conditions.some((condition) => eventReasonMatchesField(reason, condition.field));
  });

  if (!relatedRules.length) {
    return;
  }

  const matchedRules = relatedRules.filter((evaluation) => evaluation.matched);
  if (!matchedRules.length) {
    console.warn(`${DEBUG_NAMESPACE} Condition changed but no rules matched.`, {
      reason,
      currentValues: runtimeState.currentValues,
      rules: relatedRules.map(summarizeRuleEvaluation),
    });
    return;
  }

  const failedFields = (Array.isArray(fieldOutcomes) ? fieldOutcomes : []).filter((outcome) =>
    outcome &&
    ["missing-meta", "no-options", "skipped-failed-payload", "failed"].includes(outcome.status)
  );

  if (failedFields.length) {
    console.warn(`${DEBUG_NAMESPACE} Conditions matched, but hiding could not be fully applied.`, {
      reason,
      hiddenMap,
      matchedRules: matchedRules.map(summarizeRuleEvaluation),
      fieldOutcomes: failedFields,
    });
  }
}

function shouldLogConditionFailure(reason) {
  return typeof reason === "string" && reason.startsWith("event:");
}

function eventReasonMatchesField(reason, fieldId) {
  if (!reason || !fieldId) {
    return false;
  }

  return reason === `event:ticket.${fieldId === "ticket_type" ? "type" : fieldId}Changed` ||
    reason === `event:ticket.${fieldId === "ticket_type" ? "type" : fieldId}Changed:details`;
}

function summarizeRuleEvaluation(evaluation) {
  return {
    ruleId: evaluation.rule && evaluation.rule.id,
    ruleName: evaluation.rule && evaluation.rule.name,
    conditionOperator: evaluation.conditionOperator,
    matched: evaluation.matched,
    conditions: (evaluation.conditions || []).map((condition) => ({
      field: condition.field,
      expected: condition.expected,
      currentValue: condition.currentValue,
      matched: condition.matched,
      reason: condition.reason,
    })),
  };
}

function normalizeConditionOperator(value) {
  return normalizeValue(value) === "or" ? "or" : "and";
}

function normalizeCustomFields(customFields) {
  if (Array.isArray(customFields)) {
    return customFields.reduce((accumulator, item) => {
      if (item && item.name) {
        accumulator[item.name] = extractObjectValue(item.name, item.value);
      }
      return accumulator;
    }, {});
  }

  if (customFields && typeof customFields === "object") {
    return Object.keys(customFields).reduce((accumulator, key) => {
      accumulator[key] = extractObjectValue(key, customFields[key]);
      return accumulator;
    }, {});
  }

  return {};
}

function extractOptionRecords(options) {
  if (!Array.isArray(options)) {
    return [];
  }

  return options
    .map((option) => {
      if (typeof option === "string") {
        return {
          label: option,
          uiValue: option,
          rawValue: option,
          submitValue: option,
        };
      }

      if (option && typeof option === "object") {
        const rawValue = option.value !== undefined && option.value !== null
          ? option.value
          : option.label;
        const uiValue = rawValue;
        const label = option.label !== undefined && option.label !== null
          ? option.label
          : rawValue;

        if (label === "" || uiValue === "" || rawValue === "") {
          return null;
        }

        return {
          label: String(label),
          uiValue,
          rawValue,
          submitValue: rawValue,
        };
      }

      return null;
    })
    .filter(Boolean);
}

async function resolveAvailableOptions(fieldName, fieldMeta, hiddenMap) {
  const dependentOptions = resolveDependentHierarchyOptionRecords(fieldName, fieldMeta, hiddenMap);
  if (dependentOptions !== null) {
    debugLog("field:options-dependent-hierarchy", {
      fieldName,
      options: dependentOptions,
    });
    return dependentOptions;
  }

  const cachedOptions = runtimeState.liveFieldOptions[fieldName];
  if (Array.isArray(cachedOptions) && cachedOptions.length) {
    return cachedOptions;
  }

  const objectName = buildFieldOptionsObjectName(fieldMeta);
  if (objectName) {
    try {
      const response = await client.data.get(objectName);
      const rawOptions = response && response[objectName];
      const options = mapLiveOptionsToRecords(fieldName, fieldMeta, rawOptions);
      if (options.length) {
        runtimeState.liveFieldOptions[fieldName] = options;
        debugLog("field:options-live", {
          fieldName,
          objectName,
          options,
        });
        return options;
      }
    } catch (error) {
      debugLog("field:options-live-failed", {
        fieldName,
        objectName,
        message: error && error.message,
      });
      console.warn(`Unable to load live options for ${fieldName}:`, error);
    }
  }

  const triggerOptionsFallback = resolveTriggerOptionRecords(fieldName, fieldMeta);
  if (triggerOptionsFallback.length) {
    runtimeState.liveFieldOptions[fieldName] = triggerOptionsFallback;
    debugLog("field:options-trigger-fallback", {
      fieldName,
      options: triggerOptionsFallback,
    });
    return triggerOptionsFallback;
  }

  const fallbackOptions = resolveFieldCatalogOptionRecords(fieldMeta);
  runtimeState.liveFieldOptions[fieldName] = fallbackOptions;
  debugLog("field:options-field-catalog-fallback", {
    fieldName,
    options: fallbackOptions,
  });
  return fallbackOptions;
}

function resolveDependentHierarchyOptionRecords(fieldName, fieldMeta, hiddenMap) {
  const choiceTree = Array.isArray(fieldMeta && fieldMeta.root_choice_tree)
    ? fieldMeta.root_choice_tree
    : [];
  const levels = Array.isArray(fieldMeta && fieldMeta.root_levels)
    ? fieldMeta.root_levels
    : [];

  if (!choiceTree.length || !levels.length) {
    return null;
  }

  const targetIndex = levels.findIndex((level) => level && level.name === fieldName);
  if (targetIndex === -1) {
    return null;
  }

  let choiceNodes = annotateDependentChoiceNodes(choiceTree);
  for (let index = 0; index < targetIndex; index += 1) {
    const level = levels[index];
    const levelMeta = runtimeState.fieldCatalog[level.name] || level;
    const hiddenValues = hiddenMap && Array.isArray(hiddenMap[level.name])
      ? hiddenMap[level.name]
      : [];
    const nextNodes = [];

    (Array.isArray(choiceNodes) ? choiceNodes : []).forEach((choiceNode) => {
      const shouldExcludeBranch = hiddenValues.some((hiddenValue) =>
        choiceNodeMatchesHiddenValue(levelMeta, choiceNode, hiddenValue, choiceNode && choiceNode.pathValues)
      );

      if (shouldExcludeBranch) {
        return;
      }

      nextNodes.push(...annotateDependentChoiceNodes(
        choiceNode && choiceNode.children,
        choiceNode && choiceNode.pathValues
      ));
    });

    choiceNodes = nextNodes;
  }

  const options = [];
  const seen = new Set();

  (Array.isArray(choiceNodes) ? choiceNodes : []).forEach((choiceNode) => {
    const rawValue = choiceNode && choiceNode.value;
    const label = choiceNode && (choiceNode.label !== undefined && choiceNode.label !== null
      ? choiceNode.label
      : rawValue);
    const submitValue = normalizeSubmitValue(fieldMeta, rawValue);
    const key = normalizeOptionComparisonValue(fieldMeta, submitValue || label);

    if (!key || seen.has(key)) {
      return;
    }

    seen.add(key);
    options.push({
      label,
      uiValue: label,
      rawValue,
      submitValue,
      pathValues: choiceNode && choiceNode.pathValues,
    });
  });

  return options;
}

function annotateDependentChoiceNodes(choiceNodes, parentPathValues) {
  const pathValues = Array.isArray(parentPathValues) ? parentPathValues : [];

  return (Array.isArray(choiceNodes) ? choiceNodes : []).map((choiceNode) => {
    const label = getDependentChoiceNodeLabel(choiceNode);
    return {
      ...choiceNode,
      pathValues: [...pathValues, label],
    };
  });
}

function choiceNodeMatchesHiddenValue(fieldMeta, choiceNode, hiddenValue, pathValues) {
  const hiddenPath = decodeDependentChoicePath(hiddenValue);
  if (hiddenPath) {
    if (dependentChoicePathMatches(pathValues, hiddenPath)) {
      return true;
    }

    return optionLikeValueMatchesHiddenPath(fieldMeta, {
      label: choiceNode && choiceNode.label,
      rawValue: choiceNode && choiceNode.value,
      submitValue: choiceNode && choiceNode.value,
      uiValue: choiceNode && choiceNode.label,
    }, hiddenPath);
  }

  const normalizedHiddenValue = normalizeOptionComparisonValue(fieldMeta, hiddenValue);
  if (normalizedHiddenValue === null || normalizedHiddenValue === "") {
    return false;
  }

  return [
    choiceNode && choiceNode.value,
    choiceNode && choiceNode.label,
  ].some((candidate) => (
    normalizeOptionComparisonValue(fieldMeta, candidate) === normalizedHiddenValue
  ));
}

function buildDependentOptionPayloadCandidates(fieldMeta, hiddenMap) {
  const objectMapPayload = buildDependentOptionPayload(
    fieldMeta,
    fieldMeta && fieldMeta.root_choice_tree,
    hiddenMap,
    0,
    [],
    "object"
  );
  const nestedArrayPayload = buildDependentOptionPayload(
    fieldMeta,
    fieldMeta && fieldMeta.root_choice_tree,
    hiddenMap,
    0,
    [],
    "array"
  );
  const candidates = [
    {
      strategy: "dependentHierarchyObjectMap",
      id: [fieldMeta.element_id],
      values: objectMapPayload,
    },
    {
      strategy: "dependentHierarchyNestedArray",
      id: [fieldMeta.element_id],
      values: nestedArrayPayload,
    },
  ];

  return orderDependentPayloadCandidates(fieldMeta, candidates);
}

function buildDependentOptionPayload(fieldMeta, choiceNodes, hiddenMap, levelIndex, parentPathValues, childShape) {
  const levels = Array.isArray(fieldMeta && fieldMeta.root_levels)
    ? fieldMeta.root_levels
    : [];
  const level = levels[levelIndex];
  const levelMeta = level && level.name
    ? runtimeState.fieldCatalog[level.name] || level
    : fieldMeta;
  const hiddenValues = hiddenMap && level && Array.isArray(hiddenMap[level.name])
    ? hiddenMap[level.name]
    : [];
  const pathValues = Array.isArray(parentPathValues) ? parentPathValues : [];

  return (Array.isArray(choiceNodes) ? choiceNodes : [])
    .map((choiceNode) => {
      const label = getDependentChoiceNodeLabel(choiceNode);
      const currentPathValues = [...pathValues, label];
      const children = Array.isArray(choiceNode && choiceNode.children)
        ? choiceNode.children
        : [];

      if (hiddenValues.some((hiddenValue) =>
        choiceNodeMatchesHiddenValue(levelMeta, choiceNode, hiddenValue, currentPathValues)
      )) {
        return null;
      }

      return {
        [String(label)]: children.length
          ? buildDependentChildPayload(fieldMeta, children, hiddenMap, levelIndex + 1, currentPathValues, childShape)
          : {},
      };
    })
    .filter(Boolean);
}

function buildDependentChildPayload(fieldMeta, choiceNodes, hiddenMap, levelIndex, parentPathValues, childShape) {
  const payload = buildDependentOptionPayload(
    fieldMeta,
    choiceNodes,
    hiddenMap,
    levelIndex,
    parentPathValues,
    childShape
  );

  if (childShape === "object") {
    return payload.reduce((result, item) => ({
      ...result,
      ...item,
    }), {});
  }

  return payload;
}

function getDependentChoiceNodeLabel(choiceNode) {
  return choiceNode && (choiceNode.label !== undefined && choiceNode.label !== null
    ? choiceNode.label
    : choiceNode && choiceNode.value);
}

function orderDependentPayloadCandidates(fieldMeta, candidates) {
  const preferredStrategy = runtimeState.optionPayloadPreferences[fieldMeta && fieldMeta.name];
  if (!preferredStrategy) {
    return candidates;
  }

  const preferredIndex = candidates.findIndex((candidate) => candidate.strategy === preferredStrategy);
  if (preferredIndex <= 0) {
    return candidates;
  }

  const preferred = candidates[preferredIndex];
  return [preferred, ...candidates.filter((candidate) => candidate.strategy !== preferred.strategy)];
}

function decodeDependentChoicePath(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const stringValue = String(value).trim();
  if (!stringValue.startsWith(DEPENDENT_PATH_VALUE_PREFIX)) {
    return null;
  }

  try {
    const parsed = JSON.parse(stringValue.slice(DEPENDENT_PATH_VALUE_PREFIX.length));
    if (!Array.isArray(parsed)) {
      return null;
    }

    const path = parsed
      .map((item) => String(item === null || item === undefined ? "" : item).trim())
      .filter(Boolean);
    return path.length ? path : null;
  } catch {
    return null;
  }
}

function dependentChoicePathMatches(pathValues, hiddenPath) {
  const normalizedPath = (Array.isArray(pathValues) ? pathValues : [])
    .map(normalizeValue)
    .filter((value) => value !== null && value !== "");
  const normalizedHiddenPath = (Array.isArray(hiddenPath) ? hiddenPath : [])
    .map(normalizeValue)
    .filter((value) => value !== null && value !== "");

  return (
    normalizedPath.length === normalizedHiddenPath.length &&
    normalizedPath.every((value, index) => value === normalizedHiddenPath[index])
  );
}

function getDependentHiddenPathLeaf(hiddenPath) {
  const normalizedPath = (Array.isArray(hiddenPath) ? hiddenPath : [])
    .map((item) => String(item === null || item === undefined ? "" : item).trim())
    .filter(Boolean);

  return normalizedPath.length ? normalizedPath[normalizedPath.length - 1] : null;
}

function hiddenValueMatchesCurrentFieldValue(hiddenValue, currentValue) {
  const hiddenPath = decodeDependentChoicePath(hiddenValue);
  const valueToCompare = hiddenPath
    ? getDependentHiddenPathLeaf(hiddenPath)
    : hiddenValue;

  return normalizeValue(valueToCompare) === normalizeValue(currentValue);
}

function buildFieldOptionsObjectName(fieldMeta) {
  const elementId = fieldMeta && fieldMeta.element_id;
  if (!elementId) {
    return "";
  }

  if (
    elementId === "status" ||
    elementId === "priority" ||
    elementId === "ticket_type" ||
    elementId.startsWith("cf_")
  ) {
    return `${elementId}_options`;
  }

  return "";
}

function resolveTriggerOptionRecords(fieldName, fieldMeta) {
  return extractOptionRecords(runtimeState.triggerFieldCatalog[fieldName]).map((option) => ({
    ...option,
    submitValue: normalizeSubmitValue(fieldMeta, option.rawValue),
  }));
}

function resolveFieldCatalogOptionRecords(fieldMeta) {
  return extractOptionRecords(fieldMeta && fieldMeta.options).map((option) => ({
    ...option,
    submitValue: normalizeSubmitValue(fieldMeta, option.rawValue),
  }));
}

function mapLiveOptionsToRecords(fieldName, fieldMeta, rawOptions) {
  const liveOptions = extractOptionRecords(rawOptions);
  if (!liveOptions.length) {
    return [];
  }

  const triggerOptions = resolveTriggerOptionRecords(fieldName, fieldMeta);
  if (!triggerOptions.length) {
    return liveOptions;
  }

  return liveOptions.map((liveOption) => {
    const matched = triggerOptions.find((triggerOption) => (
      normalizeOptionComparisonValue(fieldMeta, triggerOption.label) ===
        normalizeOptionComparisonValue(fieldMeta, liveOption.label) ||
      normalizeOptionComparisonValue(fieldMeta, triggerOption.rawValue) ===
        normalizeOptionComparisonValue(fieldMeta, liveOption.rawValue) ||
      normalizeOptionComparisonValue(fieldMeta, triggerOption.label) ===
        normalizeOptionComparisonValue(fieldMeta, liveOption.rawValue) ||
      normalizeOptionComparisonValue(fieldMeta, triggerOption.rawValue) ===
        normalizeOptionComparisonValue(fieldMeta, liveOption.label)
    ));

    if (!matched) {
      return liveOption;
    }

    return {
      label: matched.label,
      uiValue: liveOption.uiValue,
      rawValue: matched.rawValue,
      submitValue: matched.submitValue,
    };
  });
}

function optionMatchesHiddenValue(fieldMeta, option, hiddenValue) {
  const hiddenPath = decodeDependentChoicePath(hiddenValue);
  if (hiddenPath) {
    if (Array.isArray(option && option.pathValues) && dependentChoicePathMatches(option.pathValues, hiddenPath)) {
      return true;
    }

    return optionLikeValueMatchesHiddenPath(fieldMeta, option, hiddenPath);
  }

  return optionValueCandidates(fieldMeta, option).some((candidate) => (
    candidate === normalizeOptionComparisonValue(fieldMeta, hiddenValue)
  ));
}

function optionLikeValueMatchesHiddenPath(fieldMeta, option, hiddenPath) {
  const hiddenLeafValue = getDependentHiddenPathLeaf(hiddenPath);
  if (hiddenLeafValue === null || hiddenLeafValue === "") {
    return false;
  }

  const normalizedHiddenLeafValue = normalizeOptionComparisonValue(fieldMeta, hiddenLeafValue);
  return optionValueCandidates(fieldMeta, option).some((candidate) => candidate === normalizedHiddenLeafValue);
}

function optionMatchesCurrentValue(fieldMeta, option, currentValue) {
  const normalizedCurrentValue = normalizeOptionComparisonValue(fieldMeta, currentValue);
  if (normalizedCurrentValue === null || normalizedCurrentValue === "") {
    return false;
  }

  return optionValueCandidates(fieldMeta, option).some((candidate) => candidate === normalizedCurrentValue);
}

function optionValueCandidates(fieldMeta, option) {
  return [
    option && option.label,
    option && option.rawValue,
    option && option.submitValue,
    option && option.uiValue,
  ]
    .map((candidate) => normalizeOptionComparisonValue(fieldMeta, candidate))
    .filter((candidate) => candidate !== null && candidate !== "");
}

function buildOptionPayloadCandidates(fieldName, fieldMeta, options) {
  const strategies = resolveOptionPayloadStrategies(fieldName, fieldMeta);
  const payloadCandidates = [];
  const seenKeys = new Set();

  strategies.forEach((strategy) => {
    const values = dedupePayloadValues(
      (Array.isArray(options) ? options : [])
        .map((option) => strategy.pick(option))
        .filter((value) => value !== null && value !== undefined && value !== "")
    );
    if ((Array.isArray(options) ? options : []).length && !values.length) {
      return;
    }

    const key = serializeOptions(values);

    if (seenKeys.has(key)) {
      return;
    }

    seenKeys.add(key);
    payloadCandidates.push({
      strategy: strategy.name,
      values,
    });
  });

  return payloadCandidates.length ? payloadCandidates : [{ strategy: "submitValue", values: [] }];
}

function buildDependentChildOptionPayloadCandidates(fieldName, fieldMeta, options, hiddenMap) {
  const baseCandidates = buildOptionPayloadCandidates(fieldName, fieldMeta, options);
  const rootElementId = getDependentRootElementId(fieldMeta);
  const nestedIdPath = getDependentFieldElementPath(fieldName, fieldMeta);
  const payloadCandidates = [];
  const seenKeys = new Set();

  function addCandidate(candidate, id, strategySuffix, extra) {
    const values = Array.isArray(candidate && candidate.values) ? candidate.values : [];
    const normalizedId = id || fieldMeta.element_id;
    const key = `${JSON.stringify(normalizedId)}::${serializeOptions(values)}`;

    if (seenKeys.has(key)) {
      return;
    }

    seenKeys.add(key);
    payloadCandidates.push({
      strategy: `${candidate.strategy}:${strategySuffix}`,
      id,
      values,
      ...(extra || {}),
    });
  }

  baseCandidates.forEach((candidate) => {
    if (nestedIdPath.length > 1) {
      addCandidate(candidate, nestedIdPath, "dependentNestedPath");
    }

    if (rootElementId && fieldMeta.element_id && rootElementId !== fieldMeta.element_id) {
      addCandidate(candidate, [rootElementId, fieldMeta.element_id], "dependentRootChildPath");
    }

    addCandidate(candidate, fieldMeta.element_id, "dependentChildId");
  });

  const rootFieldMeta = runtimeState.fieldCatalog[fieldMeta && fieldMeta.root_name];
  if (rootFieldMeta && isDependentRootField(rootFieldMeta.root_name || rootFieldMeta.name, rootFieldMeta)) {
    const postApplyPayloads = buildDependentRootRestorePayloadCandidates(rootFieldMeta);

    buildDependentOptionPayloadCandidates(rootFieldMeta, hiddenMap).forEach((candidate) => {
      addCandidate({
        strategy: candidate.strategy,
        values: candidate.values,
      }, candidate.id, "dependentRootHierarchyFallback", {
        postApplyPayloads,
      });
    });
  }

  return payloadCandidates.length ? payloadCandidates : baseCandidates;
}

function buildDependentRootRestorePayloadCandidates(rootFieldMeta) {
  const rootElementId = rootFieldMeta && rootFieldMeta.element_id;
  const rootValues = getDependentRootOptionValues(rootFieldMeta);

  if (!rootElementId || !rootValues.length) {
    return [];
  }

  return [
    {
      strategy: "restoreRootOptionsFlatId",
      id: rootElementId,
      values: rootValues,
    },
    {
      strategy: "restoreRootOptionsArrayId",
      id: [rootElementId],
      values: rootValues,
    },
  ];
}

function getDependentRootOptionValues(rootFieldMeta) {
  const choiceTree = Array.isArray(rootFieldMeta && rootFieldMeta.root_choice_tree)
    ? rootFieldMeta.root_choice_tree
    : [];

  if (choiceTree.length) {
    return dedupePayloadValues(
      choiceTree
        .map((choiceNode) => getDependentChoiceNodeLabel(choiceNode))
        .filter((value) => value !== null && value !== undefined && value !== "")
    );
  }

  const rootLevel = Array.isArray(rootFieldMeta && rootFieldMeta.root_levels)
    ? rootFieldMeta.root_levels[0]
    : null;

  return dedupePayloadValues(
    (Array.isArray(rootLevel && rootLevel.options) ? rootLevel.options : [])
      .map((option) => option && (option.value !== undefined && option.value !== null ? option.value : option.label))
      .filter((value) => value !== null && value !== undefined && value !== "")
  );
}

function getDependentRootElementId(fieldMeta) {
  const rootName = fieldMeta && fieldMeta.root_name;
  const rootMeta = rootName ? runtimeState.fieldCatalog[rootName] : null;
  return (
    (rootMeta && rootMeta.element_id) ||
    rootName ||
    (fieldMeta && fieldMeta.element_id) ||
    ""
  );
}

function getDependentFieldElementPath(fieldName, fieldMeta) {
  const levels = Array.isArray(fieldMeta && fieldMeta.root_levels)
    ? fieldMeta.root_levels
    : [];
  const targetIndex = levels.findIndex((level) => level && level.name === fieldName);

  if (targetIndex === -1) {
    const rootElementId = getDependentRootElementId(fieldMeta);
    return rootElementId && fieldMeta && fieldMeta.element_id
      ? [rootElementId, fieldMeta.element_id]
      : [];
  }

  return levels
    .slice(0, targetIndex + 1)
    .map((level) => {
      const levelMeta = level && level.name ? runtimeState.fieldCatalog[level.name] : null;
      return (levelMeta && levelMeta.element_id) || (level && level.element_id) || (level && level.name);
    })
    .filter(Boolean);
}

function dedupePayloadValues(values) {
  const deduped = [];
  const seen = new Set();

  (Array.isArray(values) ? values : []).forEach((value) => {
    const key = normalizeValue(value);
    if (key === null || seen.has(key)) {
      return;
    }

    seen.add(key);
    deduped.push(value);
  });

  return deduped;
}

function resolveOptionPayloadStrategies(fieldName, fieldMeta) {
  const strategies = fieldMeta && fieldMeta.element_id === "status"
    ? [
        { name: "submitValue", pick: (option) => option && option.submitValue },
        { name: "rawValue", pick: (option) => option && option.rawValue },
        { name: "uiValue", pick: (option) => option && option.uiValue },
        { name: "label", pick: (option) => option && option.label },
      ]
    : [
        { name: "submitValue", pick: (option) => option && option.submitValue },
      ];

  if (fieldMeta && fieldMeta.element_id === "status") {
    return strategies;
  }

  if (isDependentHierarchyField(fieldMeta)) {
    return [
      { name: "submitValue", pick: (option) => option && option.submitValue },
      { name: "label", pick: (option) => option && option.label },
      { name: "rawValue", pick: (option) => option && option.rawValue },
      { name: "uiValue", pick: (option) => option && option.uiValue },
    ];
  }

  const preferredStrategy = runtimeState.optionPayloadPreferences[fieldName];
  if (!preferredStrategy) {
    return strategies;
  }

  const preferredIndex = strategies.findIndex((strategy) => strategy.name === preferredStrategy);
  if (preferredIndex <= 0) {
    return strategies;
  }

  const preferred = strategies[preferredIndex];
  return [preferred, ...strategies.filter((strategy) => strategy.name !== preferred.name)];
}

function normalizeSubmitValue(fieldMeta, value) {
  const elementId = fieldMeta && fieldMeta.element_id;
  const stringValue = value === null || value === undefined ? "" : String(value).trim();

  if (["status", "priority", "group", "agent", "product"].includes(elementId) && /^\d+$/.test(stringValue)) {
    return Number(stringValue);
  }

  return value;
}

function arraysMatch(left, right) {
  const leftArray = Array.isArray(left) ? left : [];
  const rightArray = Array.isArray(right) ? right : [];

  if (leftArray.length !== rightArray.length) {
    return false;
  }

  return leftArray.every(
    (item, index) => normalizeComparableOption(item) === normalizeComparableOption(rightArray[index])
  );
}

function normalizeComparableOption(value) {
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  return normalizeValue(value);
}

function shouldSkipFailedPayload(fieldName, nextOptionsKey) {
  const failedRecord = runtimeState.lastFailedOptions[fieldName];
  if (!failedRecord) {
    return false;
  }

  if (typeof failedRecord === "string") {
    return false;
  }

  if (failedRecord.key !== nextOptionsKey) {
    return false;
  }

  return Date.now() - Number(failedRecord.failedAt || 0) < FAILED_PAYLOAD_RETRY_COOLDOWN_MS;
}

function getFailedPayloadRetryAfter(fieldName) {
  const failedRecord = runtimeState.lastFailedOptions[fieldName];
  if (!failedRecord || typeof failedRecord === "string") {
    return 0;
  }

  const elapsed = Date.now() - Number(failedRecord.failedAt || 0);
  return Math.max(0, FAILED_PAYLOAD_RETRY_COOLDOWN_MS - elapsed);
}

function serializeOptions(options) {
  return JSON.stringify(Array.isArray(options) ? options : []);
}

function logStatusConsole(stage, details, fieldMeta, level) {
  if (!fieldMeta || fieldMeta.element_id !== "status") {
    return;
  }

  const method = level === "error"
    ? "error"
    : level === "warn"
      ? "warn"
      : "log";
  console[method](`${DEBUG_NAMESPACE} status:${stage}`, details);
}

function logDependentTrace(stage, details, level) {
  const payload = details || {};
  if (
    stage === "rules-evaluated" &&
    !((payload.rules || []).length) &&
    !Object.keys(payload.hiddenMap || {}).length
  ) {
    return;
  }

  const method = level === "error"
    ? "error"
    : level === "warn"
      ? "warn"
      : "log";

  console[method](`${DEBUG_NAMESPACE} dependent:${stage}`, payload);
}

function logDependentConditionMatches(reason, evaluations, hiddenMap) {
  const matchedRules = summarizeDependentEvaluations(evaluations)
    .filter((rule) => rule.active && rule.matched);

  if (!matchedRules.length) {
    return;
  }

  logDependentTrace("condition-met", {
    reason,
    matchedRules,
    hiddenMap,
  });
}

function summarizeDependentEvaluations(evaluations) {
  return (Array.isArray(evaluations) ? evaluations : [])
    .filter((evaluation) => evaluation && evaluation.rule && evaluation.rule.kind === "dependent")
    .map((evaluation) => ({
      ruleId: evaluation.rule.id,
      ruleName: evaluation.rule.name,
      active: evaluation.active,
      matched: evaluation.matched,
      operator: evaluation.conditionOperator,
      targetRootName: evaluation.rule.target_root_name,
      targetRootLabel: evaluation.rule.target_root_label,
      hiddenSelections: summarizeHiddenSelections(evaluation.rule.hidden_selections),
      conditions: (evaluation.conditions || []).map((condition) => ({
        field: condition.field,
        expected: condition.expected,
        currentValue: condition.currentValue,
        matched: condition.matched,
        reason: condition.reason,
      })),
    }));
}

function summarizeHiddenSelections(hiddenSelections) {
  return (Array.isArray(hiddenSelections) ? hiddenSelections : []).map((selection) => ({
    fieldName: selection && selection.field_name,
    fieldLabel: selection && selection.field_label,
    elementId: selection && selection.element_id,
    hiddenValues: selection && selection.hidden_values,
    hiddenValueLabels: selection && selection.hidden_value_labels,
  }));
}

function summarizePayloadCandidates(candidates) {
  return (Array.isArray(candidates) ? candidates : []).map((candidate) => ({
    strategy: candidate && candidate.strategy,
    id: candidate && candidate.id,
    values: candidate && candidate.values,
    postApplyPayloads: summarizePayloadCandidates(candidate && candidate.postApplyPayloads),
  }));
}

function summarizeOptionsForConsole(options) {
  return (Array.isArray(options) ? options : []).map((option) => ({
    label: option && option.label,
    uiValue: option && option.uiValue,
    rawValue: option && option.rawValue,
    submitValue: option && option.submitValue,
    pathValues: option && option.pathValues,
  }));
}

function normalizeOptionComparisonValue(fieldMeta, value) {
  return normalizeFieldComparisonValue(fieldMeta && fieldMeta.element_id, value);
}

function normalizeFieldComparisonValue(fieldId, value) {
  const normalizedValue = normalizeValue(value);
  if (normalizedValue === null) {
    return null;
  }

  if (fieldId === "status") {
    return normalizedValue.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  }

  return normalizedValue;
}

function normalizeValue(value) {
  if (value === null || value === undefined) {
    return null;
  }
  return String(value).trim().toLowerCase();
}

function extractObjectValue(fieldId, source) {
  if (source === null || source === undefined) {
    return null;
  }

  if (typeof source !== "object") {
    return source;
  }

  if (source.new !== undefined && source.new !== null) {
    const nestedNewValue = extractObjectValue(fieldId, source.new);
    if (nestedNewValue !== null) {
      return nestedNewValue;
    }
  }

  const candidates = {
    status: ["status", "status_id"],
    priority: ["priority", "priority_id"],
    ticket_type: ["type", "ticket_type", "ticket_type_id"],
    group: ["group", "group_id"],
    agent: ["agent", "agent_id", "responder_id"],
    source: ["source", "source_id"],
  };

  const keys = candidates[fieldId] || [];
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (source[key] !== undefined && source[key] !== null) {
      const nestedValue = extractObjectValue(fieldId, source[key]);
      if (nestedValue !== null) {
        return nestedValue;
      }
    }
  }

  const genericKeys = ["name", "label", "text"];
  for (let index = 0; index < genericKeys.length; index += 1) {
    const key = genericKeys[index];
    if (source[key] !== undefined && source[key] !== null) {
      return source[key];
    }
  }

  if (source.ticket && typeof source.ticket === "object") {
    return extractObjectValue(fieldId, source.ticket);
  }

  if (source.value !== undefined && source.value !== null) {
    const nestedValue = extractObjectValue(fieldId, source.value);
    if (nestedValue !== null) {
      return nestedValue;
    }
  }

  if (source.id !== undefined && source.id !== null) {
    return source.id;
  }

  return null;
}

function normalizeTriggerValue(fieldId, value) {
  const normalized = normalizeFieldComparisonValue(fieldId, value);
  if (normalized === null || normalized === "") {
    return normalized;
  }

  const options = runtimeState.triggerFieldCatalog[fieldId] || [];
  const matched = options.find((option) => {
    const optionValue = normalizeFieldComparisonValue(fieldId, option && option.value);
    const optionLabel = normalizeFieldComparisonValue(fieldId, option && option.label);
    return optionValue === normalized || optionLabel === normalized;
  });

  if (matched) {
    return normalizeValue(matched.value);
  }

  return normalized;
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
  return payload.message || payload.detail || (payload.error && payload.error.message) || "";
}

function isDebugEnabled() {
  try {
    return (
      localStorage.getItem(DEBUG_STORAGE_KEY) === "1" ||
      window.location.search.includes(`${DEBUG_STORAGE_KEY}=1`)
    );
  } catch {
    return false;
  }
}

function debugLog(eventName, details) {
  if (!isDebugEnabled()) {
    return;
  }

  const entry = {
    time: new Date().toISOString(),
    event: eventName,
    details: details || {},
  };

  try {
    if (!window.__DHP_DEBUG__) {
      window.__DHP_DEBUG__ = [];
    }
    window.__DHP_DEBUG__.push(entry);
    if (window.__DHP_DEBUG__.length > DEBUG_HISTORY_LIMIT) {
      window.__DHP_DEBUG__.shift();
    }
  } catch {
    // Ignore debug history failures.
  }

  if (details === undefined) {
    console.log(DEBUG_NAMESPACE, eventName);
    return;
  }

  console.log(DEBUG_NAMESPACE, eventName, details);
}
