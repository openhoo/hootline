import type { IntakeResult } from "@support-desk/contracts";

const QUEUE_LABELS = {
  billing: "Billing",
  incident: "Incident response",
  priority: "Priority support",
  support: "General support",
};

export function QueueCard({ result }: { result: IntakeResult }) {
  const displayQueue =
    result.ticket.severity === "critical"
      ? "incident"
      : result.customerPlan.prioritySupport
        ? "priority"
        : result.assignment.queue;
  return (
    <section aria-label="Queue assignment">
      <h2>{QUEUE_LABELS[displayQueue]}</h2>
      <p>{result.assignment.ownerTeam}</p>
    </section>
  );
}
