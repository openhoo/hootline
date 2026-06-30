export const REQUESTER_PROFILES = Object.freeze({
  "vip.example.com": Object.freeze({
    accountId: "acme-enterprise",
    customerPlanId: "enterprise",
    preferredChannel: "email",
    preferredLocale: "de-DE",
    timezone: "Europe/Berlin",
  }),
  "startup.example.com": Object.freeze({
    accountId: "seed-startup",
    customerPlanId: "startup",
    preferredChannel: "sms",
    preferredLocale: "en-US",
    timezone: "America/New_York",
  }),
  default: Object.freeze({
    accountId: "self-serve",
    customerPlanId: "free",
    preferredChannel: "email",
    preferredLocale: "en-US",
    timezone: "UTC",
  }),
});

export function requesterDomain(email) {
  const [, domain = ""] = String(email).trim().toLowerCase().split("@");
  return domain;
}

export function resolveRequesterProfile(email) {
  return REQUESTER_PROFILES[requesterDomain(email)] ?? REQUESTER_PROFILES.default;
}
