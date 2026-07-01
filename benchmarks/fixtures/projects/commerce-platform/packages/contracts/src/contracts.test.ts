import { describe, expect, it } from "vitest";

import { PRODUCT_CATALOG, isValidCheckoutRequest } from "./index";

describe("commerce contracts", () => {
  it("marks digital gift cards as non-taxable and non-shippable", () => {
    expect(PRODUCT_CATALOG["digital-gift-card"]).toMatchObject({
      taxable: false,
      fulfillmentType: "digital",
      weightOunces: 0,
    });
  });

  it("rejects malformed checkout request quantities", () => {
    expect(
      isValidCheckoutRequest({
        destinationState: "OR",
        items: [{ sku: "coffee-beans", quantity: 0 }],
      }),
    ).toBe(false);
  });
});
