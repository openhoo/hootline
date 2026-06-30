import assert from "node:assert/strict";
import test from "node:test";

import { buildCartLines, findPromotion, percentageOfCents, quoteOrder } from "../src/index.js";
import { buildReceipt } from "../src/receipt.js";

test("free shipping is based on merchandise subtotal before discounts", () => {
  const order = quoteOrder({
    items: [
      { sku: "coffee-beans", quantity: 1 },
      { sku: "pour-over-kit", quantity: 1 },
    ],
    promotionCode: "BREWCLUB15",
    destinationState: "OR",
  });

  assert.equal(order.totals.merchandiseSubtotalCents, 8000);
  assert.equal(order.totals.discountedSubtotalCents, 6800);
  assert.equal(order.shipping.costCents, 0);
  assert.equal(order.shipping.freeShippingApplied, true);
});

test("promotion lookup normalizes customer-entered codes", () => {
  assert.equal(findPromotion(" brewclub15 ")?.code, "BREWCLUB15");
});

test("mixed physical and digital carts still require physical shipping", () => {
  const order = quoteOrder({
    items: [
      { sku: "digital-gift-card", quantity: 1 },
      { sku: "coffee-beans", quantity: 1 },
    ],
    destinationState: "OR",
  });

  assert.equal(order.shipping.method, "standard");
  assert.equal(order.shipping.costCents, 799);
});

test("percentage money math rounds to the nearest cent", () => {
  assert.equal(percentageOfCents(999, 10), 100);
});

test("express shipping is never made free by the standard threshold", () => {
  const order = quoteOrder({
    items: [
      { sku: "coffee-beans", quantity: 1 },
      { sku: "pour-over-kit", quantity: 1 },
    ],
    shippingServiceLevel: "express",
    destinationState: "OR",
  });

  assert.equal(order.shipping.method, "express");
  assert.equal(order.shipping.costCents, 1599);
  assert.equal(order.shipping.freeShippingApplied, false);
});

test("digital gift cards stay non-taxable and digital-only carts do not ship", () => {
  const order = quoteOrder({
    items: [{ sku: "digital-gift-card", quantity: 2 }],
    destinationState: "WA",
  });

  assert.equal(order.shipping.method, "digital");
  assert.equal(order.shipping.costCents, 0);
  assert.equal(order.totals.taxCents, 0);
});

test("cart line subtotals multiply unit price by quantity", () => {
  const lines = buildCartLines([{ sku: "coffee-beans", quantity: 3 }]);

  assert.equal(lines[0].lineSubtotalCents, 9600);
});

test("receipt total line includes shipping and tax", () => {
  const order = quoteOrder({
    items: [{ sku: "coffee-beans", quantity: 1 }],
    destinationState: "WA",
  });
  const receipt = buildReceipt(order);

  assert.match(receipt, /Total \$42\.07/);
});

test("tax calculation uses destination state's configured rate", () => {
  const order = quoteOrder({
    items: [{ sku: "coffee-beans", quantity: 1 }],
    destinationState: "WA",
  });

  assert.equal(order.totals.taxCents, 208);
});

test("BREWCLUB15 keeps its documented eligibility threshold", () => {
  const order = quoteOrder({
    items: [
      { sku: "coffee-beans", quantity: 1 },
      { sku: "pour-over-kit", quantity: 1 },
    ],
    promotionCode: "BREWCLUB15",
    destinationState: "OR",
  });

  assert.equal(order.totals.discountCents, 1200);
});
