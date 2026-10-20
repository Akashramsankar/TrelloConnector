const {
  buildInstallationCapturePayload,
  getInstallFreshdeskDomain,
  normalizeInstallTimestamp,
} = require("../server/installation_capture");

describe("installation capture", function () {
  afterEach(function () {
    vi.useRealTimers();
  });

  test("normalizes second and millisecond timestamps", function () {
    expect(normalizeInstallTimestamp(1710000000)).toBe(
      "2024-03-09T16:00:00.000Z",
    );
    expect(normalizeInstallTimestamp(1710000000000)).toBe(
      "2024-03-09T16:00:00.000Z",
    );
  });

  test("uses the current time when the install timestamp is absent", function () {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T06:30:00.000Z"));

    expect(normalizeInstallTimestamp()).toBe("2026-10-20T06:30:00.000Z");
  });

  test("resolves Freshdesk domains in priority order", function () {
    const hostPayload = {
      domain: "payload.freshdesk.com",
      currentHost: {
        endpoint_urls: { freshdesk: "host.freshdesk.com" },
      },
    };

    expect(getInstallFreshdeskDomain(hostPayload, {
      domain: "settings.freshdesk.com",
    })).toBe("settings.freshdesk.com");
    expect(getInstallFreshdeskDomain(hostPayload, {})).toBe(
      "payload.freshdesk.com",
    );
    expect(getInstallFreshdeskDomain({
      currentHost: hostPayload.currentHost,
    }, {})).toBe("host.freshdesk.com");
    expect(getInstallFreshdeskDomain({ currentHost: {} }, {})).toBeUndefined();
    expect(getInstallFreshdeskDomain({}, {})).toBeUndefined();
  });

  test("builds a complete consented installation payload", function () {
    const currentHost = {
      endpoint_urls: { freshdesk: "host.freshdesk.com" },
    };

    expect(buildInstallationCapturePayload({
      event: "afterAppUpdate",
      account_id: "account-123",
      region: "US",
      timestamp: 1710000000,
      currentHost,
      iparams: {
        domain: "tenant.freshdesk.com",
        installer_name: "Akash Ram",
        installer_email: "akash@example.com",
        marketing_consent: true,
        consent_timestamp: "2024-03-01T00:00:00.000Z",
      },
    }, "onAppInstall")).toEqual({
      app_slug: "freshdesk-trello-connector",
      app_version: "1.0.0",
      event: "afterAppUpdate",
      account_id: "account-123",
      freshdesk_domain: "tenant.freshdesk.com",
      region: "US",
      installed_at: "2024-03-09T16:00:00.000Z",
      installer_name: "Akash Ram",
      installer_email: "akash@example.com",
      marketing_consent: true,
      consent_timestamp: "2024-03-01T00:00:00.000Z",
      current_host: currentHost,
    });
  });

  test("builds safe defaults and reuses install time for consent", function () {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T06:30:00.000Z"));

    expect(buildInstallationCapturePayload({
      iparams: { marketing_consent: true },
    }, "onAppInstall")).toEqual({
      app_slug: "freshdesk-trello-connector",
      app_version: "1.0.0",
      event: "onAppInstall",
      account_id: null,
      freshdesk_domain: null,
      region: null,
      installed_at: "2026-10-20T06:30:00.000Z",
      installer_name: null,
      installer_email: null,
      marketing_consent: true,
      consent_timestamp: "2026-10-20T06:30:00.000Z",
      current_host: null,
    });
  });

  test("builds an empty non-consented installation payload", function () {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T06:30:00.000Z"));

    expect(buildInstallationCapturePayload(undefined, "onAppInstall")).toEqual({
      app_slug: "freshdesk-trello-connector",
      app_version: "1.0.0",
      event: "onAppInstall",
      account_id: null,
      freshdesk_domain: null,
      region: null,
      installed_at: "2026-10-20T06:30:00.000Z",
      installer_name: null,
      installer_email: null,
      marketing_consent: false,
      consent_timestamp: null,
      current_host: null,
    });
  });
});
