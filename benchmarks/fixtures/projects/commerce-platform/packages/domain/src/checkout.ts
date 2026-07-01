import type { CheckoutQuote, CheckoutRequest, CustomerTier } from "@commerce-platform/contracts";

import { buildCartLines, reserveInventory, resolveCustomer, sumLineSubtotals, taxableSubtotal } from "./catalog";
import { authorizePayment } from "./payments";
import { calculateDiscountCents, percentageOfCents, tierDiscountPercent } from "./pricing";
import { quoteShipping } from "./shipping";
import { calculateTaxCents } from "./tax";

export function quoteOrder(input: CheckoutRequest & { customerTier?: CustomerTier }): CheckoutQuote {
  const customer = resolveCustomer(input.customerId);
  const customerTier = input.customerTier ?? customer.tier;
  const destinationState = input.destinationState ?? customer.defaultDestinationState;
  const lines = buildCartLines(input.items);
  const merchandiseSubtotalCents = sumLineSubtotals(lines);
  const promotionDiscountCents = calculateDiscountCents(merchandiseSubtotalCents, input.promotionCode);
  const tierDiscountCents = percentageOfCents(
    merchandiseSubtotalCents - promotionDiscountCents,
    tierDiscountPercent(customerTier),
  );
  const discountedSubtotalCents = merchandiseSubtotalCents - promotionDiscountCents - tierDiscountCents;
  const taxableBasisCents = customer.taxExempt ? 0 : taxableSubtotal(lines) - promotionDiscountCents - tierDiscountCents;
  const taxCents = calculateTaxCents(Math.max(0, taxableBasisCents), destinationState);
  const shipping = quoteShipping({
    discountedSubtotalCents,
    lines,
    merchandiseSubtotalCents,
    requestedService: input.shippingServiceLevel,
  });
  const payment = authorizePayment({
    amountCents: discountedSubtotalCents + shipping.costCents + taxCents,
    customerId: customer.id,
    idempotencyKey: input.idempotencyKey ?? "checkout",
  });

  return {
    customer,
    items: lines,
    inventoryReservations: reserveInventory(lines, customer.preferredWarehouseRegion),
    payment,
    shipping,
    totals: {
      merchandiseSubtotalCents,
      promotionDiscountCents,
      tierDiscountCents,
      discountedSubtotalCents,
      shippingCents: shipping.costCents,
      taxCents,
      totalCents: discountedSubtotalCents + shipping.costCents + taxCents,
    },
  };
}
