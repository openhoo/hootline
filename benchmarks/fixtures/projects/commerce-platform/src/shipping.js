export const FREE_SHIPPING_THRESHOLD_CENTS = 7500;

const SHIPPING_RATES = Object.freeze({
  standard: Object.freeze({ method: "standard", costCents: 799 }),
  express: Object.freeze({ method: "express", costCents: 1599 }),
  freight: Object.freeze({ method: "freight", costCents: 2599 }),
});

export function quoteShipping({
  merchandiseSubtotalCents,
  discountedSubtotalCents,
  requiresShipping,
  serviceLevel = "standard",
  weightOunces = 0,
}) {
  if (!requiresShipping) {
    return {
      method: "digital",
      costCents: 0,
      freeShippingApplied: false,
    };
  }

  const requestedService = weightOunces > 80 ? "freight" : serviceLevel;
  const service = SHIPPING_RATES[requestedService] ?? SHIPPING_RATES.standard;
  const shippingBasisCents = merchandiseSubtotalCents;
  const freeShippingApplied =
    service.method === "standard" && shippingBasisCents >= FREE_SHIPPING_THRESHOLD_CENTS;

  return {
    method: service.method,
    costCents: freeShippingApplied ? 0 : service.costCents,
    freeShippingApplied,
  };
}
