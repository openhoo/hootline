import { buildCartLines, physicalWeightOunces, sumLineSubtotals, taxableSubtotal } from "./catalog.js";
import { customerTaxableSubtotal, resolveCustomer } from "./customers.js";
import { reserveInventory } from "./inventory.js";
import { applyStoreCredit, authorizePayment } from "./payments.js";
import { calculateDiscountCents } from "./promotions.js";
import { quoteShipping } from "./shipping.js";
import { calculateTaxCents } from "./tax.js";

export function quoteOrder({
  customerId = "guest",
  destinationState = "OR",
  idempotencyKey,
  items,
  promotionCode,
  shippingServiceLevel = "standard",
  storeCreditCents = 0,
  warehouseRegion,
}) {
  const customer = resolveCustomer(customerId);
  const fulfillmentRegion = warehouseRegion ?? customer.preferredWarehouseRegion ?? "west";
  const lines = buildCartLines(items);
  const inventoryReservations = reserveInventory(lines, fulfillmentRegion);
  const merchandiseSubtotalCents = sumLineSubtotals(lines);
  const discountCents = calculateDiscountCents(merchandiseSubtotalCents, promotionCode);
  const discountedSubtotalCents = merchandiseSubtotalCents - discountCents;
  const allDigital = lines.every((line) => line.weightOunces === 0);
  const shipping = quoteShipping({
    merchandiseSubtotalCents,
    discountedSubtotalCents,
    requiresShipping: !allDigital,
    serviceLevel: shippingServiceLevel,
    weightOunces: physicalWeightOunces(lines),
  });
  const taxableBasisCents = customerTaxableSubtotal(customer, taxableSubtotal(lines));
  const taxCents = calculateTaxCents(taxableBasisCents, destinationState);
  const totalBeforeCreditCents = discountedSubtotalCents + shipping.costCents + taxCents;
  const payment = applyStoreCredit(totalBeforeCreditCents, storeCreditCents);
  const authorization = authorizePayment({
    amountDueCents: payment.amountDueCents,
    customerId: customer.id,
    idempotencyKey,
  });

  return {
    customer,
    customerId: customer.id,
    fulfillmentRegion,
    inventoryReservations,
    lines,
    payment: {
      ...payment,
      authorization,
    },
    shipping,
    totals: {
      merchandiseSubtotalCents,
      discountCents,
      discountedSubtotalCents,
      taxCents,
      shippingCents: shipping.costCents,
      totalBeforeCreditCents,
      totalCents: payment.amountDueCents,
    },
  };
}
