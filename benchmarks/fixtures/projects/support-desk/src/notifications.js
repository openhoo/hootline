export function notificationKey(ticket, channel) {
  const normalizedChannel = String(channel).trim().toLowerCase();
  return `${ticket.id}:${normalizedChannel}:${ticket.requesterEmail}`;
}

export function buildNotification(ticket, channel) {
  return {
    key: notificationKey(ticket, channel),
    to: ticket.requesterEmail,
    channel,
    subject: `Ticket ${ticket.id}: ${ticket.subject}`,
  };
}
