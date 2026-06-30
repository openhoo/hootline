export function canCloseTicket(user, ticket) {
  return user.role === "admin" || user.team === ticket.team;
}

export function canViewTicket(user, ticket) {
  if (user.role === "admin") return true;
  return user.team === ticket.team || user.email === ticket.requesterEmail;
}
