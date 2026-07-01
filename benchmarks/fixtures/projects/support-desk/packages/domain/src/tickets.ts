import type { LocaleCode, TicketIntakeRequest, TicketRecord } from "@support-desk/contracts";

export function createTicket(input: TicketIntakeRequest): TicketRecord {
  const requesterEmail = String(input.requesterEmail).trim().toLowerCase();
  const tags = (input.tags ?? []).map((tag) => String(tag).trim().toLowerCase()).filter(Boolean);
  return {
    customerPlanId: input.customerPlanId ?? "free",
    id: input.id,
    locale: input.locale ?? "en-US",
    openedAt: input.openedAt ?? new Date("2026-01-15T10:00:00.000Z").toISOString(),
    requesterEmail,
    severity: input.severity ?? "normal",
    status: "open",
    subject: input.subject,
    tags,
    team: input.team ?? "support",
  };
}

export function normalizeLocale(locale: LocaleCode | undefined): LocaleCode {
  return locale ?? "en-US";
}
