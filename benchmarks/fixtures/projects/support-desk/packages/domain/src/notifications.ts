import type { LocaleCode, NotificationPreview, TicketRecord } from "@support-desk/contracts";

const SUBJECT_PREFIX_BY_LOCALE: Record<LocaleCode, string> = {
  "en-US": "Request",
  "de-DE": "Anfrage",
  "fr-FR": "Demande",
};

export function buildNotification(ticket: TicketRecord, channel: "email" | "slack" = "email"): NotificationPreview {
  const locale = ticket.locale;
  const prefix = SUBJECT_PREFIX_BY_LOCALE[locale] ?? SUBJECT_PREFIX_BY_LOCALE["en-US"];
  return {
    channel,
    locale,
    subject: `${prefix} ${ticket.id}: ${ticket.subject}`,
  };
}
