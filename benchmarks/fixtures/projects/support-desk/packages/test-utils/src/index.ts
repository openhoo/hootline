import type { TicketIntakeRequest } from "@support-desk/contracts";
import { intakeTicket } from "@support-desk/domain";

export function enterpriseBillingTicket(overrides: Partial<TicketIntakeRequest> = {}): TicketIntakeRequest {
  return {
    id: "T-108",
    openedAt: "2026-01-15T10:00:00.000Z",
    requesterEmail: "lead@vip.example.com",
    subject: "Billing account issue",
    tags: ["billing"],
    ...overrides,
  };
}

export function enterpriseBillingIntake(overrides: Partial<TicketIntakeRequest> = {}) {
  return intakeTicket(enterpriseBillingTicket(overrides));
}
