import type { Assignment, CustomerPlan, TicketRecord } from "@support-desk/contracts";

export function routeTicket(ticket: TicketRecord, customerPlan: CustomerPlan): Assignment {
  if (ticket.severity === "critical") return { queue: "incident", ownerTeam: "incident-response" };
  if (ticket.tags.includes("billing")) return { queue: "billing", ownerTeam: "billing" };
  if (customerPlan.prioritySupport) return { queue: "priority", ownerTeam: "senior-support" };
  return { queue: "support", ownerTeam: ticket.team };
}
