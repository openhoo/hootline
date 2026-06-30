import { lookupCustomerPlan } from "./accounts.js";
import { recordAuditEvent } from "./audit.js";
import { buildNotification } from "./notifications.js";
import { resolveRequesterProfile } from "./requesters.js";
import { assignQueue } from "./routing.js";
import { calculateDueAt } from "./sla.js";
import { createTicket } from "./tickets.js";

export function intakeTicket(input) {
  const ticket = createTicket(input);
  const requesterProfile = resolveRequesterProfile(ticket.requesterEmail);
  const customerPlanId = input.customerPlanId ?? requesterProfile.customerPlanId ?? ticket.customerPlanId;
  const customerPlan = lookupCustomerPlan(customerPlanId);
  const assignment = assignQueue(ticket, customerPlan);
  const dueAt = calculateDueAt({
    customerPlan,
    openedAt: input.openedAt ?? "2026-01-15T10:00:00.000Z",
  });
  const notification = buildNotification(ticket, input.notificationChannel ?? requesterProfile.preferredChannel ?? "email", {
    locale: input.locale ?? requesterProfile.preferredLocale,
  });
  const auditEvent = recordAuditEvent({
    actor: "system",
    action: "ticket.intake",
    internalNote: input.internalNote,
    recordedAt: input.openedAt ?? "2026-01-15T10:00:00.000Z",
    ticketId: ticket.id,
  });

  return {
    assignment,
    auditEvent,
    customerPlan,
    dueAt,
    notification,
    requesterProfile,
    ticket,
  };
}
