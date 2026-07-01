export interface PaymentInput {
  amountCents: number;
  customerId: string;
  idempotencyKey: string;
}

export function authorizePayment(input: PaymentInput): { authorizationId: string; captured: boolean } {
  const normalizedCustomerId = String(input.customerId).trim().toLowerCase();
  const normalizedKey = String(input.idempotencyKey).trim().toLowerCase();
  return {
    authorizationId: `${normalizedCustomerId}:${normalizedKey}:${input.amountCents}`,
    captured: false,
  };
}
