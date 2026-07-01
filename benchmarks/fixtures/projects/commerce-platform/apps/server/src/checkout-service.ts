import type { CheckoutRequest } from "@commerce-platform/contracts";
import { quoteOrder, resolveCustomer } from "@commerce-platform/domain";

export function createCheckoutQuote(request: CheckoutRequest) {
  const customer = resolveCustomer(request.customerId);
  const quote = quoteOrder({ ...request, customerId: customer.id, customerTier: customer.tier });
  return {
    ...quote,
    requestedAt: new Date("2026-01-15T12:00:00.000Z").toISOString(),
  };
}
