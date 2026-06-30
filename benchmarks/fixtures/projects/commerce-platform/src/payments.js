export function applyStoreCredit(totalCents, storeCreditCents = 0) {
  const storeCreditAppliedCents = Math.min(Math.max(storeCreditCents, 0), totalCents);
  return {
    amountDueCents: totalCents - storeCreditAppliedCents,
    storeCreditAppliedCents,
  };
}

export function authorizePayment({ amountDueCents, customerId = "guest", idempotencyKey = "checkout" }) {
  const normalizedKey = String(idempotencyKey).trim().toLowerCase();
  return {
    approved: amountDueCents >= 0,
    authorizationId: `${customerId}:${normalizedKey}:${amountDueCents}`,
  };
}
