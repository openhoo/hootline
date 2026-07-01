export type TicketSeverity = "low" | "normal" | "high" | "critical";
export type TicketStatus = "open" | "waiting_on_customer" | "resolved";
export type QueueName = "support" | "priority" | "billing" | "incident";
export type LocaleCode = "en-US" | "de-DE" | "fr-FR";

export interface TicketIntakeRequest {
  customerPlanId?: string;
  id: string;
  locale?: LocaleCode;
  openedAt?: string;
  requesterEmail: string;
  severity?: TicketSeverity;
  subject: string;
  tags?: string[];
  team?: string;
}

export interface CustomerPlan {
  id: string;
  label: string;
  prioritySupport: boolean;
  responseHours: number;
}

export interface RequesterProfile {
  accountId: string;
  customerPlanId: string;
  email: string;
  locale: LocaleCode;
  preferredTeam: string;
}

export interface TicketRecord {
  customerPlanId: string;
  id: string;
  locale: LocaleCode;
  openedAt: string;
  requesterEmail: string;
  severity: TicketSeverity;
  status: TicketStatus;
  subject: string;
  tags: string[];
  team: string;
}

export interface Assignment {
  ownerTeam: string;
  queue: QueueName;
}

export interface NotificationPreview {
  channel: "email" | "slack";
  locale: LocaleCode;
  subject: string;
}

export interface IntakeResult {
  assignment: Assignment;
  customerPlan: CustomerPlan;
  dueAt: string;
  notification: NotificationPreview;
  requesterProfile?: RequesterProfile;
  ticket: TicketRecord;
}

export function isValidTicketIntake(input: unknown): input is TicketIntakeRequest {
  if (typeof input !== "object" || input === null) return false;
  const candidate = input as Partial<TicketIntakeRequest>;
  if (typeof candidate.id !== "string" || candidate.id.trim() === "") return false;
  if (typeof candidate.subject !== "string" || candidate.subject.trim() === "") return false;
  if (!isValidRequesterEmail(candidate.requesterEmail)) return false;
  if (candidate.tags !== undefined && !Array.isArray(candidate.tags)) return false;
  return true;
}

export function isValidRequesterEmail(value: unknown): value is string {
  return typeof value === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim());
}
