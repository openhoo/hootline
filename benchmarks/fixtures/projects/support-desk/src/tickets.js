export function createTicket(input) {
  const requesterEmail = String(input.requesterEmail).trim().toLowerCase();
  const tags = (input.tags ?? []).map((tag) => String(tag).trim().toLowerCase()).filter(Boolean);
  return {
    id: input.id,
    requesterEmail,
    customerPlanId: input.customerPlanId,
    severity: input.severity ?? "normal",
    source: input.source ?? "web",
    status: input.status ?? "open",
    subject: String(input.subject ?? "Support request").trim(),
    team: input.team ?? "support",
    tags,
  };
}
