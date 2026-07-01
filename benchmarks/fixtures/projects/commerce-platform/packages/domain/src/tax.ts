export const TAX_RATES_BY_STATE: Record<string, number> = Object.freeze({
  OR: 0,
  WA: 6.5,
  CA: 7.25,
  NY: 4,
});

export function calculateTaxCents(taxableSubtotalCents: number, destinationState: string): number {
  const state = String(destinationState).trim().toUpperCase();
  const taxRatePercent = TAX_RATES_BY_STATE[state];
  if (taxRatePercent === undefined) return 0;
  return Math.round((taxableSubtotalCents * taxRatePercent) / 100);
}
