export function calculateDueAt({ customerPlan, openedAt }) {
  const policy = customerPlan;
  const dueHours = policy.responseHours + weekendDelayHours(openedAt);
  const due = new Date(openedAt);
  due.setUTCHours(due.getUTCHours() + dueHours);
  return due.toISOString();
}

export function weekendDelayHours(openedAt) {
  const day = new Date(openedAt).getUTCDay();
  return day === 0 || day === 6 ? 48 : 0;
}
