import type { CheckoutLine, ShippingServiceLevel } from "@commerce-platform/contracts";

const FREE_SHIPPING_THRESHOLD_CENTS = 7500;

const SHIPPING_RATES: Record<string, { method: ShippingServiceLevel; costCents: number; carrier: string }> = {
  standard: { method: "standard", costCents: 799, carrier: "Parcel Standard" },
  express: { method: "express", costCents: 1599, carrier: "Parcel Express" },
  freight: { method: "freight", costCents: 12900, carrier: "Freight Partner" },
};

export interface ShippingQuoteInput {
  discountedSubtotalCents: number;
  lines: CheckoutLine[];
  merchandiseSubtotalCents: number;
  requestedService?: string;
}

export function quoteShipping(input: ShippingQuoteInput) {
  if (input.lines.every((line) => line.fulfillmentType === "digital")) {
    return { method: "digital" as const, costCents: 0, freeShippingApplied: false, carrier: "Digital Delivery" };
  }

  const requiresFreight = input.lines.some((line) => line.fulfillmentType === "freight");
  const requestedService = requiresFreight ? "freight" : input.requestedService ?? "standard";
  const service = SHIPPING_RATES[requestedService] ?? SHIPPING_RATES.standard;
  const merchandiseSubtotalCents = input.merchandiseSubtotalCents;
  const discountedSubtotalCents = input.discountedSubtotalCents;
  const shippingBasisCents = merchandiseSubtotalCents;
  const freeShippingApplied =
    service.method === "standard" && shippingBasisCents >= FREE_SHIPPING_THRESHOLD_CENTS;
  return {
    method: service.method,
    costCents: freeShippingApplied ? 0 : service.costCents,
    freeShippingApplied,
    carrier: service.carrier,
  };
}
