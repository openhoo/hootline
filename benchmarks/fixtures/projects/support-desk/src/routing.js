export function routeTicket(ticket, customerPlan) {
  if (ticket.severity === "critical") return "incident";
  if (ticket.tags.includes("billing")) return "billing";
  if (customerPlan.prioritySupport) return "priority";
  if (ticket.tags.includes("bug")) return "engineering";
  return "support";
}

export function assignQueue(ticket, customerPlan) {
  const queue = routeTicket(ticket, customerPlan);
  return {
    queue,
    ownerTeam: queue === "incident" ? "incident-response" : queue,
  };
}
