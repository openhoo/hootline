import type { RequesterProfile, TicketIntakeRequest } from "@support-desk/contracts";

import { buildNotification } from "./notifications";
import { lookupCustomerPlan } from "./plans";
import { routeTicket } from "./routing";
import { calculateDueAt } from "./sla";
import { createTicket } from "./tickets";

const REQUESTER_PROFILES: Record<string, RequesterProfile> = Object.freeze({
  "lead@vip.example.com": Object.freeze({
    accountId: "acme-enterprise",
    customerPlanId: "enterprise",
    email: "lead@vip.example.com",
    locale: "de-DE",
    preferredTeam: "priority",
  }),
  "finance@vip.example.com": Object.freeze({
    accountId: "acme-enterprise",
    customerPlanId: "enterprise",
    email: "finance@vip.example.com",
    locale: "fr-FR",
    preferredTeam: "billing",
  }),
});

export function lookupRequesterProfile(email: string): RequesterProfile | undefined {
  return REQUESTER_PROFILES[String(email).trim().toLowerCase()];
}

export function intakeTicket(input: TicketIntakeRequest) {
  const requesterProfile = lookupRequesterProfile(input.requesterEmail);
  const customerPlanId = input.customerPlanId ?? requesterProfile?.customerPlanId ?? "free";
  const customerPlan = lookupCustomerPlan(customerPlanId);
  const ticket = createTicket({
    ...input,
    customerPlanId,
    locale: input.locale ?? requesterProfile?.locale,
    team: input.team ?? requesterProfile?.preferredTeam,
  });
  const assignment = routeTicket(ticket, customerPlan);
  const notification = buildNotification(ticket);
  return {
    assignment,
    customerPlan,
    dueAt: calculateDueAt(ticket.openedAt, customerPlan),
    notification,
    requesterProfile,
    ticket,
  };
}
