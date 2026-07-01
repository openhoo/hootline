import { NotificationPreview } from "./components/NotificationPreview";
import { QueueCard } from "./components/QueueCard";
import { buildTicketDraft } from "./ticket-draft";

import type { IntakeResult } from "@support-desk/contracts";

const demoResult: IntakeResult = {
  assignment: { queue: "incident", ownerTeam: "incident-response" },
  customerPlan: { id: "enterprise", label: "Enterprise", prioritySupport: true, responseHours: 4 },
  dueAt: "2026-01-15T14:00:00.000Z",
  notification: { channel: "email", locale: "de-DE", subject: "Anfrage T-100: Billing outage" },
  ticket: {
    customerPlanId: "enterprise",
    id: "T-100",
    locale: "de-DE",
    openedAt: "2026-01-15T10:00:00.000Z",
    requesterEmail: "lead@vip.example.com",
    severity: "critical",
    status: "open",
    subject: "Billing outage",
    tags: ["billing"],
    team: "priority",
  },
};

export function App() {
  const draft = buildTicketDraft({
    id: "T-100",
    requesterEmail: " LEAD@VIP.EXAMPLE.COM ",
    subject: "Billing outage",
  });

  return (
    <main>
      <h1>Support operations</h1>
      <p data-testid="requester-email">{draft.requesterEmail}</p>
      <QueueCard result={demoResult} />
      <NotificationPreview notification={demoResult.notification} />
    </main>
  );
}
