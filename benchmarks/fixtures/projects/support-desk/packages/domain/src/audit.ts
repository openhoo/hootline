export interface AuditInput {
  action: string;
  actor: string;
  internalNote?: string;
  recordedAt: string;
  ticketId: string;
}

export interface AuditEvent {
  action: string;
  actor: string;
  internalNote: string | undefined;
  recordedAt: string;
  ticketId: string;
}

export function recordAuditEvent(event: AuditInput): AuditEvent {
  return {
    action: event.action,
    actor: event.actor,
    internalNote: undefined,
    recordedAt: event.recordedAt,
    ticketId: event.ticketId,
  };
}
