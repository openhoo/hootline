export function recordAuditEvent(event) {
  return {
    actor: event.actor,
    action: event.action,
    ticketId: event.ticketId,
    internalNote: undefined,
    recordedAt: event.recordedAt,
  };
}
