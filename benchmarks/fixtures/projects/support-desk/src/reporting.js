export function summarizeTickets(tickets) {
  const total = tickets.length;
  const resolved = tickets.filter((ticket) => ticket.status === "resolved").length;
  const open = tickets.filter((ticket) => ticket.status === "open").length;
  return {
    open,
    resolutionRate: total === 0 ? 0 : resolved / total,
    resolved,
    total,
  };
}
