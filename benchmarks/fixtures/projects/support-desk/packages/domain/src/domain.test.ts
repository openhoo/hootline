import { describe, expect, it } from "vitest";

import { intakeTicket, lookupCustomerPlan, recordAuditEvent, summarizeTickets } from "./index";

describe("support domain", () => {
  it("falls back unknown customer plans to free support", () => {
    expect(lookupCustomerPlan("does-not-exist").id).toBe("free");
  });

  it("routes critical tickets to incident response before plan routing", () => {
    const result = intakeTicket({
      customerPlanId: "enterprise",
      id: "T-101",
      requesterEmail: "lead@vip.example.com",
      severity: "critical",
      subject: "Production outage",
    });

    expect(result.assignment.queue).toBe("incident");
    expect(result.assignment.ownerTeam).toBe("incident-response");
  });

  it("adds weekend delay to ticket deadlines", () => {
    const result = intakeTicket({
      customerPlanId: "enterprise",
      id: "T-102",
      openedAt: "2026-01-17T10:00:00.000Z",
      requesterEmail: "lead@vip.example.com",
      subject: "Saturday request",
    });

    expect(result.dueAt).toBe("2026-01-19T14:00:00.000Z");
  });

  it("redacts internal audit notes", () => {
    const event = recordAuditEvent({
      action: "ticket.comment",
      actor: "agent",
      internalNote: "customer threatened churn",
      recordedAt: "2026-01-15T10:00:00.000Z",
      ticketId: "T-103",
    });

    expect(event.internalNote).toBeUndefined();
  });

  it("scopes reporting by team and date window", () => {
    const summary = summarizeTickets(
      [
        {
          customerPlanId: "free",
          id: "T-1",
          locale: "en-US",
          openedAt: "2026-01-15T10:00:00.000Z",
          requesterEmail: "a@example.com",
          severity: "normal",
          status: "resolved",
          subject: "A",
          tags: [],
          team: "support",
        },
        {
          customerPlanId: "free",
          id: "T-2",
          locale: "en-US",
          openedAt: "2026-01-16T10:00:00.000Z",
          requesterEmail: "b@example.com",
          severity: "normal",
          status: "open",
          subject: "B",
          tags: [],
          team: "billing",
        },
      ],
      { team: "support", from: "2026-01-15T00:00:00.000Z", to: "2026-01-15T23:59:59.000Z" },
    );

    expect(summary.total).toBe(1);
    expect(summary.resolutionRate).toBe(1);
  });

  it("uses requester profiles for plan inference, billing routing, and locale", () => {
    const result = intakeTicket({
      id: "T-108",
      openedAt: "2026-01-15T10:00:00.000Z",
      requesterEmail: "lead@vip.example.com",
      subject: "Billing account issue",
      tags: ["billing"],
    });

    expect(result.requesterProfile?.accountId).toBe("acme-enterprise");
    expect(result.customerPlan.id).toBe("enterprise");
    expect(result.assignment.queue).toBe("billing");
    expect(result.notification.subject).toBe("Anfrage T-108: Billing account issue");
  });
});
