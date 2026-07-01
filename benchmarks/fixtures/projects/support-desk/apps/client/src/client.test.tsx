import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { IntakeResult, NotificationPreview as NotificationPreviewModel } from "@support-desk/contracts";

import { NotificationPreview } from "./components/NotificationPreview";
import { QueueCard } from "./components/QueueCard";
import { buildTicketDraft } from "./ticket-draft";

const result: IntakeResult = {
  assignment: { queue: "incident", ownerTeam: "incident-response" },
  customerPlan: { id: "enterprise", label: "Enterprise", prioritySupport: true, responseHours: 4 },
  dueAt: "2026-01-15T14:00:00.000Z",
  notification: { channel: "email", locale: "de-DE", subject: "Anfrage T-500: Production outage" },
  ticket: {
    customerPlanId: "enterprise",
    id: "T-500",
    locale: "de-DE",
    openedAt: "2026-01-15T10:00:00.000Z",
    requesterEmail: "lead@vip.example.com",
    severity: "critical",
    status: "open",
    subject: "Production outage",
    tags: [],
    team: "priority",
  },
};

const notification: NotificationPreviewModel = {
  channel: "email",
  locale: "de-DE",
  subject: "Anfrage T-500: Production outage",
};

describe("support client", () => {
  it("normalizes requester email in ticket drafts", () => {
    expect(
      buildTicketDraft({
        id: "T-500",
        requesterEmail: " LEAD@VIP.EXAMPLE.COM ",
        subject: "Production outage",
      }).requesterEmail,
    ).toBe("lead@vip.example.com");
  });

  it("renders incident priority ahead of enterprise plan priority", () => {
    render(<QueueCard result={result} />);
    expect(screen.getByText("Incident response")).toBeTruthy();
  });

  it("renders localized notification previews", () => {
    render(<NotificationPreview notification={notification} />);
    expect(screen.getByText("Anfrage T-500: Production outage")).toBeTruthy();
  });
});
