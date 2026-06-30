import assert from "node:assert/strict";
import test from "node:test";

import {
  buildNotification,
  canCloseTicket,
  createTicket,
  intakeTicket,
  lookupCustomerPlan,
  recordAuditEvent,
  routeTicket,
  summarizeTickets,
} from "../src/index.js";

test("ticket intake normalizes requester email", () => {
  const ticket = createTicket({
    id: "T-100",
    requesterEmail: " USER@Example.COM ",
    subject: "Login help",
  });

  assert.equal(ticket.requesterEmail, "user@example.com");
});

test("unknown customer plans fall back to free support", () => {
  assert.equal(lookupCustomerPlan("does-not-exist").id, "free");
});

test("priority support routes enterprise tickets to priority queue", () => {
  const result = intakeTicket({
    id: "T-101",
    requesterEmail: "vip@example.com",
    customerPlanId: "enterprise",
    subject: "Contract question",
  });

  assert.equal(result.assignment.queue, "priority");
});

test("critical tickets route to incident response before plan routing", () => {
  const result = intakeTicket({
    id: "T-102",
    requesterEmail: "vip@example.com",
    customerPlanId: "enterprise",
    severity: "critical",
    subject: "Production outage",
  });

  assert.equal(result.assignment.queue, "incident");
  assert.equal(result.assignment.ownerTeam, "incident-response");
});

test("weekend ticket deadlines include weekend delay", () => {
  const result = intakeTicket({
    id: "T-103",
    requesterEmail: "user@example.com",
    customerPlanId: "enterprise",
    openedAt: "2026-01-17T10:00:00.000Z",
    subject: "Saturday request",
  });

  assert.equal(result.dueAt, "2026-01-19T14:00:00.000Z");
});

test("admins can close tickets outside their team", () => {
  const ticket = createTicket({
    id: "T-104",
    requesterEmail: "user@example.com",
    team: "billing",
  });

  assert.equal(canCloseTicket({ role: "admin", team: "support" }, ticket), true);
});

test("notification keys dedupe channel case and whitespace", () => {
  const ticket = createTicket({ id: "T-105", requesterEmail: "user@example.com" });
  const first = buildNotification(ticket, " Email ");
  const second = buildNotification(ticket, "email");

  assert.equal(first.key, second.key);
});

test("audit events redact internal notes", () => {
  const event = recordAuditEvent({
    actor: "agent",
    action: "ticket.comment",
    internalNote: "customer threatened churn",
    recordedAt: "2026-01-15T10:00:00.000Z",
    ticketId: "T-106",
  });

  assert.equal(event.internalNote, undefined);
});

test("reporting calculates resolution rate from resolved tickets", () => {
  const summary = summarizeTickets([
    { status: "resolved" },
    { status: "open" },
    { status: "resolved" },
  ]);

  assert.equal(summary.resolutionRate, 2 / 3);
});

test("ticket tags are normalized for routing", () => {
  const ticket = createTicket({
    id: "T-107",
    requesterEmail: "user@example.com",
    tags: [" Billing ", " BUG "],
  });

  assert.deepEqual(ticket.tags, ["billing", "bug"]);
  assert.equal(routeTicket(ticket, lookupCustomerPlan("free")), "billing");
});
