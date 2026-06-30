export function shouldEscalate(ticket, customerPlan, now) {
  if (ticket.severity === "critical") return true;
  if (!customerPlan.prioritySupport) return false;
  const ageHours = (new Date(now).getTime() - new Date(ticket.openedAt).getTime()) / (60 * 60 * 1000);
  return ageHours >= customerPlan.responseHours;
}

export function escalationReason(ticket, customerPlan) {
  if (ticket.severity === "critical") return "critical severity";
  if (customerPlan.prioritySupport) return "priority SLA";
  return "standard queue";
}
