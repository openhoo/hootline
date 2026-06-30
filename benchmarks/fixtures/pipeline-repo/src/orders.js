import { buildCartLines, sumLineSubtotals, taxableSubtotal } from "./catalog.js";
import { calculateDiscountCents } from "./promotions.js";
import { quoteShipping } from "./shipping.js";
import { calculateTaxCents } from "./tax.js";

export function quoteOrder({
  items,
  promotionCode,
  destinationState = "OR",
  shippingServiceLevel = "standard",
}) {
  const lines = buildCartLines(items);
  const merchandiseSubtotalCents = sumLineSubtotals(lines);
  const discountCents = calculateDiscountCents(merchandiseSubtotalCents, promotionCode);
  const discountedSubtotalCents = merchandiseSubtotalCents - discountCents;
  const allDigital = lines.every((line) => line.weightOunces === 0);
  const shipping = quoteShipping({
    merchandiseSubtotalCents,
    discountedSubtotalCents,
    requiresShipping: !allDigital,
    serviceLevel: shippingServiceLevel,
  });
  const taxCents = calculateTaxCents(taxableSubtotal(lines), destinationState);
  const totalCents = discountedSubtotalCents + shipping.costCents + taxCents;

  return {
    lines,
    shipping,
    totals: {
      merchandiseSubtotalCents,
      discountCents,
      discountedSubtotalCents,
      taxCents,
      shippingCents: shipping.costCents,
      totalCents,
    },
  };
}
