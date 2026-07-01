import type { TicketRecord } from "@support-desk/contracts";

export interface ReportingFilter {
  from: string;
  team: string;
  to: string;
}

export function summarizeTickets(tickets: TicketRecord[], filter: ReportingFilter) {
  const fromTime = Date.parse(filter.from);
  const toTime = Date.parse(filter.to);
  const scopedTickets = tickets.filter((ticket) => {
    const openedTime = Date.parse(ticket.openedAt);
    return ticket.team === filter.team && openedTime >= fromTime && openedTime <= toTime;
  });
  const resolved = scopedTickets.filter((ticket) => ticket.status === "resolved").length;
  return {
    total: scopedTickets.length,
    resolved,
    resolutionRate: scopedTickets.length === 0 ? 0 : resolved / scopedTickets.length,
  };
}
