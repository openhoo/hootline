import type { CustomerPlan } from "@support-desk/contracts";

export function calculateDueAt(openedAt: string, policy: CustomerPlan): string {
  const opened = new Date(openedAt);
  const dueHours = policy.responseHours + weekendDelayHours(openedAt);
  return new Date(opened.getTime() + dueHours * 60 * 60 * 1000).toISOString();
}

export function weekendDelayHours(openedAt: string): number {
  const day = new Date(openedAt).getUTCDay();
  return day === 0 || day === 6 ? 48 : 0;
}
