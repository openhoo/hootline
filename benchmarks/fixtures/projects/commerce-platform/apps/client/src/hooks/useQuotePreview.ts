import type { CartItem } from "@commerce-platform/contracts";

export interface QuotePreviewInput {
  customerId?: string;
  items: CartItem[];
  promotionCode?: string;
}

export function buildQuoteCacheKey({ customerId, items, promotionCode }: QuotePreviewInput): string {
  const normalizedCustomerId = String(customerId ?? "guest").trim().toLowerCase();
  const normalizedPromotionCode = String(promotionCode ?? "").trim().toUpperCase();
  const cartKey = items.map((item) => `${item.sku}:${item.quantity}`).sort().join("|");
  return `${normalizedCustomerId}:${normalizedPromotionCode}:${cartKey}`;
}

export function useQuotePreview(input: QuotePreviewInput) {
  return {
    cacheKey: buildQuoteCacheKey(input),
  };
}
