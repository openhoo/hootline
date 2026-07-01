import type { CheckoutRequest } from "@commerce-platform/contracts";
import { quoteOrder } from "@commerce-platform/domain";

export function promotedCoffeeCart(overrides: Partial<CheckoutRequest> = {}): CheckoutRequest {
  return {
    destinationState: "OR",
    items: [
      { sku: "coffee-beans", quantity: 1 },
      { sku: "pour-over-kit", quantity: 1 },
    ],
    promotionCode: "BREWCLUB15",
    ...overrides,
  };
}

export function promotedCoffeeQuote(overrides: Partial<CheckoutRequest> = {}) {
  return quoteOrder(promotedCoffeeCart(overrides));
}
