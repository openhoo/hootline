import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFulfillmentPlan,
  buildInvoice,
  canReleaseShipment,
  customerTierLabel,
  invoiceReference,
  quoteOrder,
  resolveCustomer,
} from "../src/index.js";

test("customer lookup normalizes ids and falls back to guest", () => {
  assert.equal(resolveCustomer(" Cafe-Alma ").billingName, "Cafe Alma LLC");
  assert.equal(resolveCustomer("missing").id, "guest");
});

test("customer tier labels expose tax exempt status", () => {
  assert.equal(customerTierLabel(resolveCustomer("nonprofit-roasters")), "tax exempt");
  assert.equal(customerTierLabel(resolveCustomer("cafe-alma")), "wholesale");
});

test("fulfillment plans hold back backordered shipments", () => {
  const order = quoteOrder({
    items: [{ sku: "espresso-machine", quantity: 2 }],
    destinationState: "WA",
  });
  const plan = buildFulfillmentPlan({
    destinationState: "WA",
    reservations: order.inventoryReservations,
    shipping: order.shipping,
  });

  assert.equal(plan.status, "backordered");
  assert.equal(plan.carrier, "Pending Inventory");
  assert.equal(canReleaseShipment(plan, order.payment), false);
});

test("customer warehouse preference is used when no region is provided", () => {
  const order = quoteOrder({
    customerId: "cafe-alma",
    items: [{ sku: "coffee-beans", quantity: 1 }],
    destinationState: "OR",
  });

  assert.equal(order.fulfillmentRegion, "east");
  assert.equal(order.inventoryReservations[0].region, "east");
});

test("freight shipments use the freight carrier when inventory is ready", () => {
  const order = quoteOrder({
    items: [{ sku: "espresso-machine", quantity: 1 }],
    destinationState: "WA",
  });
  const plan = buildFulfillmentPlan({
    destinationState: "WA",
    reservations: order.inventoryReservations,
    shipping: order.shipping,
  });

  assert.equal(order.shipping.method, "freight");
  assert.equal(plan.status, "ready");
  assert.equal(plan.carrier, "Freight Partner");
  assert.equal(canReleaseShipment(plan, order.payment), true);
});

test("payment authorization uses resolved customer id and normalized idempotency key", () => {
  const order = quoteOrder({
    customerId: " Cafe-Alma ",
    idempotencyKey: " Checkout-123 ",
    items: [{ sku: "coffee-beans", quantity: 1 }],
    destinationState: "OR",
  });

  assert.equal(order.customerId, "cafe-alma");
  assert.equal(order.payment.authorization.authorizationId, "cafe-alma:checkout-123:3999");
});

test("invoice rendering includes customer identity and amount due", () => {
  const customer = resolveCustomer("cafe-alma");
  const order = quoteOrder({
    customerId: customer.id,
    items: [{ sku: "coffee-beans", quantity: 1 }],
    destinationState: "OR",
  });
  const invoice = buildInvoice({ customer, order });

  assert.match(invoice, /Bill to Cafe Alma LLC/);
  assert.match(invoice, /Amount due \$39\.99/);
  assert.equal(invoiceReference(customer, 42), "cafe-alma:000042");
});
