import { percentageOfCents } from "./money.js";

export const PROMOTIONS = Object.freeze({
  COFFEE10: Object.freeze({
    code: "COFFEE10",
    percentOff: 10,
    minimumSubtotalCents: 5000,
  }),
  BREWCLUB15: Object.freeze({
    code: "BREWCLUB15",
    percentOff: 15,
    minimumSubtotalCents: 7500,
  }),
});

export function findPromotion(promotionCode) {
  const normalizedCode = String(promotionCode).trim().toUpperCase();
  return PROMOTIONS[normalizedCode] ?? null;
}

export function calculateDiscountCents(subtotalCents, promotionCode) {
  const promotion = findPromotion(promotionCode);
  if (promotion === null) return 0;
  if (subtotalCents < promotion.minimumSubtotalCents) return 0;
  return percentageOfCents(subtotalCents, promotion.percentOff);
}
