import type { TicketRecord } from "@support-desk/contracts";
import { summarizeTickets } from "@support-desk/domain";

const REPORTING_SEED: TicketRecord[] = [
  {
    customerPlanId: "free",
    id: "T-1",
    locale: "en-US",
    openedAt: "2026-01-15T10:00:00.000Z",
    requesterEmail: "a@example.com",
    severity: "normal",
    status: "resolved",
    subject: "Login help",
    tags: [],
    team: "support",
  },
  {
    customerPlanId: "enterprise",
    id: "T-2",
    locale: "de-DE",
    openedAt: "2026-01-16T10:00:00.000Z",
    requesterEmail: "lead@vip.example.com",
    severity: "normal",
    status: "open",
    subject: "Billing question",
    tags: ["billing"],
    team: "billing",
  },
];

export function buildReportingSummary(query: { from?: string; team?: string; to?: string }) {
  const team = String(query.team ?? "support");
  const from = String(query.from ?? "2026-01-01T00:00:00.000Z");
  const to = String(query.to ?? "2026-12-31T23:59:59.000Z");
  return summarizeTickets(REPORTING_SEED, { from, team, to });
}
