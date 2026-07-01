import type { CustomerTier } from "@commerce-platform/contracts";

export const PROMOTIONS = Object.freeze({
  BREWCLUB15: Object.freeze({ code: "BREWCLUB15", percentOff: 15, minimumSubtotalCents: 5000 }),
  COFFEE10: Object.freeze({ code: "COFFEE10", percentOff: 10, minimumSubtotalCents: 0 }),
});

export function findPromotion(promotionCode: string | undefined) {
  if (promotionCode === undefined || promotionCode.trim() === "") return null;
  const normalizedCode = String(promotionCode).trim().toUpperCase();
  return PROMOTIONS[normalizedCode as keyof typeof PROMOTIONS] ?? null;
}

export function calculateDiscountCents(subtotalCents: number, promotionCode: string | undefined): number {
  const promotion = findPromotion(promotionCode);
  if (promotion === null || subtotalCents < promotion.minimumSubtotalCents) return 0;
  return percentageOfCents(subtotalCents, promotion.percentOff);
}

export function tierDiscountPercent(tier: CustomerTier): number {
  if (tier === "nonprofit") return 12;
  if (tier === "wholesale") return 5;
  return 0;
}

export function percentageOfCents(cents: number, percent: number): number {
  return Math.round((cents * percent) / 100);
}
