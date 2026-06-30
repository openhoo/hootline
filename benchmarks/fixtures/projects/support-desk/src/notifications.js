const SUBJECT_PREFIX_BY_LOCALE = Object.freeze({
  "de-DE": "Anfrage",
  "en-US": "Ticket",
});

export function notificationKey(ticket, channel) {
  const normalizedChannel = normalizeChannel(channel);
  return `${ticket.id}:${normalizedChannel}:${ticket.requesterEmail}`;
}

export function buildNotification(ticket, channel, options = {}) {
  const normalizedChannel = normalizeChannel(channel);
  const locale = options.locale ?? "en-US";
  const prefix = SUBJECT_PREFIX_BY_LOCALE[locale] ?? SUBJECT_PREFIX_BY_LOCALE["en-US"];
  return {
    key: notificationKey(ticket, normalizedChannel),
    to: ticket.requesterEmail,
    channel: normalizedChannel,
    locale,
    subject: `${prefix} ${ticket.id}: ${ticket.subject}`,
  };
}

function normalizeChannel(channel) {
  return String(channel).trim().toLowerCase();
}
