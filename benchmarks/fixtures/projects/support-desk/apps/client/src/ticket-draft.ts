import type { TicketIntakeRequest } from "@support-desk/contracts";

export function buildTicketDraft(input: TicketIntakeRequest): TicketIntakeRequest {
  return {
    ...input,
    requesterEmail: input.requesterEmail.trim().toLowerCase(),
    tags: (input.tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean),
  };
}
