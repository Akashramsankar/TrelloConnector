const { APP_SLUG, APP_VERSION } = require("./app_metadata");

function normalizeInstallTimestamp(timestamp) {
  if (!timestamp) {
    return new Date().toISOString();
  }

  const numericTimestamp = Number(timestamp);
  const timestampMs = numericTimestamp < 10000000000
    ? numericTimestamp * 1000
    : numericTimestamp;
  return new Date(timestampMs).toISOString();
}

function getInstallFreshdeskDomain(payload, iparams) {
  if (iparams.domain) {
    return iparams.domain;
  }

  if (payload.domain) {
    return payload.domain;
  }

  return payload.currentHost &&
    payload.currentHost.endpoint_urls &&
    payload.currentHost.endpoint_urls.freshdesk;
}

function valueOrNull(value) {
  return value || null;
}

function getConsentTimestamp(marketingConsent, consentTimestamp, installedAt) {
  if (!marketingConsent) {
    return null;
  }

  return consentTimestamp || installedAt;
}

function buildInstallationCapturePayload(payload = {}, fallbackEvent) {
  const iparams = payload.iparams || {};
  const installedAt = normalizeInstallTimestamp(payload.timestamp);
  const marketingConsent = Boolean(iparams.marketing_consent);
  const freshdeskDomain = getInstallFreshdeskDomain(payload, iparams);

  return {
    app_slug: APP_SLUG,
    app_version: APP_VERSION,
    event: payload.event || fallbackEvent,
    account_id: valueOrNull(payload.account_id),
    freshdesk_domain: valueOrNull(freshdeskDomain),
    region: valueOrNull(payload.region),
    installed_at: installedAt,
    installer_name: valueOrNull(iparams.installer_name),
    installer_email: valueOrNull(iparams.installer_email),
    marketing_consent: marketingConsent,
    consent_timestamp: getConsentTimestamp(
      marketingConsent,
      iparams.consent_timestamp,
      installedAt,
    ),
    current_host: valueOrNull(payload.currentHost),
  };
}

exports.buildInstallationCapturePayload = buildInstallationCapturePayload;
exports.getInstallFreshdeskDomain = getInstallFreshdeskDomain;
exports.normalizeInstallTimestamp = normalizeInstallTimestamp;
