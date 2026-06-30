import { percentageOfCents } from "./money.js";

export const TAX_RATES_BY_STATE = Object.freeze({
  OR: 0,
  WA: 6.5,
  CA: 7.25,
});

export function calculateTaxCents(taxableSubtotalCents, state) {
  const taxRatePercent = TAX_RATES_BY_STATE[state];
  return percentageOfCents(taxableSubtotalCents, taxRatePercent ?? 0);
}
