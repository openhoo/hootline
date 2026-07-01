import { describe, expect, it } from "vitest";

import { PRODUCT_CATALOG } from "@commerce-platform/contracts";

import { authorizePayment, findPromotion, quoteOrder } from "./index";

describe("commerce domain", () => {
  it("quotes free shipping from merchandise subtotal before promotions", () => {
    const order = quoteOrder({
      destinationState: "OR",
      items: [
        { sku: "coffee-beans", quantity: 1 },
        { sku: "pour-over-kit", quantity: 1 },
      ],
      promotionCode: "BREWCLUB15",
    });

    expect(order.totals.merchandiseSubtotalCents).toBe(8000);
    expect(order.totals.discountedSubtotalCents).toBe(6800);
    expect(order.shipping.costCents).toBe(0);
  });

  it("normalizes promotion codes before lookup", () => {
    expect(findPromotion(" brewclub15 ")?.code).toBe("BREWCLUB15");
  });

  it("uses the destination state tax rate", () => {
    const order = quoteOrder({
      destinationState: "WA",
      items: [{ sku: "coffee-beans", quantity: 1 }],
    });

    expect(order.totals.taxCents).toBe(208);
  });

  it("preserves payment idempotency across customer and key case", () => {
    const payment = authorizePayment({
      amountCents: 3999,
      customerId: " Cafe-Alma ",
      idempotencyKey: " Checkout-123 ",
    });

    expect(payment.authorizationId).toBe("cafe-alma:checkout-123:3999");
  });

  it("keeps digital gift cards non-taxable and non-shippable in checkout", () => {
    expect(PRODUCT_CATALOG["digital-gift-card"].taxable).toBe(false);
    const order = quoteOrder({
      destinationState: "WA",
      items: [{ sku: "digital-gift-card", quantity: 2 }],
    });

    expect(order.shipping.method).toBe("digital");
    expect(order.totals.taxCents).toBe(0);
  });

  it("survives promo, shipping, and tax cascade regressions", () => {
    const order = quoteOrder({
      destinationState: "WA",
      items: [
        { sku: "coffee-beans", quantity: 1 },
        { sku: "pour-over-kit", quantity: 1 },
      ],
      promotionCode: " brewclub15 ",
    });

    expect(order.totals.promotionDiscountCents).toBe(1200);
    expect(order.shipping.freeShippingApplied).toBe(true);
    expect(order.totals.taxCents).toBe(442);
    expect(order.totals.totalCents).toBe(7242);
  });
});
