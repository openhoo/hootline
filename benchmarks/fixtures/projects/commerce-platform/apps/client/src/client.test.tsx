import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { CheckoutQuote, ProductDefinition } from "@commerce-platform/contracts";

import { InventoryBadge } from "./components/InventoryBadge";
import { OrderSummary } from "./components/OrderSummary";
import { buildQuoteCacheKey } from "./hooks/useQuotePreview";

const quote: CheckoutQuote = {
  customer: {
    id: "guest",
    billingName: "Guest Checkout",
    tier: "retail",
    taxExempt: false,
    defaultDestinationState: "OR",
    preferredWarehouseRegion: "west",
  },
  items: [],
  inventoryReservations: [{ sku: "espresso-machine", quantity: 2, region: "west", status: "backordered" }],
  payment: { authorizationId: "guest:test:123456", captured: false },
  shipping: { method: "freight", costCents: 12900, freeShippingApplied: false, carrier: "Freight Partner" },
  totals: {
    merchandiseSubtotalCents: 124900,
    promotionDiscountCents: 0,
    tierDiscountCents: 0,
    discountedSubtotalCents: 124900,
    shippingCents: 12900,
    taxCents: 0,
    totalCents: 137800,
  },
};

const product: ProductDefinition = {
  sku: "espresso-machine",
  name: "Linea Home Espresso Machine",
  unitPriceCents: 124900,
  taxable: true,
  fulfillmentType: "freight",
  weightOunces: 580,
  stockOnHand: 1,
};

describe("commerce client", () => {
  it("renders the authoritative API total", () => {
    render(<OrderSummary quote={quote} />);
    expect(screen.getByText("Total $1,378.00")).toBeTruthy();
  });

  it("normalizes promotion codes in quote cache keys", () => {
    expect(
      buildQuoteCacheKey({
        customerId: " Cafe-Alma ",
        items: [{ sku: "coffee-beans", quantity: 1 }],
        promotionCode: " brewclub15 ",
      }),
    ).toBe("cafe-alma:BREWCLUB15:coffee-beans:1");
  });

  it("uses reservation status for inventory badges", () => {
    render(<InventoryBadge product={product} reservation={quote.inventoryReservations[0]} />);
    expect(screen.getByText("Backordered")).toBeTruthy();
  });
});
