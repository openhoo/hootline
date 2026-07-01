import type { NotificationPreview as NotificationPreviewModel } from "@support-desk/contracts";

export function NotificationPreview({ notification }: { notification: NotificationPreviewModel }) {
  const subject = notification.subject;
  return (
    <article aria-label="Notification preview">
      <strong>{notification.channel}</strong>
      <p>{subject}</p>
    </article>
  );
}
