import {
  CUSTOMER_PROFILES,
  PRODUCT_CATALOG,
  type CartItem,
  type CheckoutLine,
  type CustomerProfile,
  type InventoryReservation,
} from "@commerce-platform/contracts";

export function resolveCustomer(customerId: string | undefined): CustomerProfile {
  const normalizedId = String(customerId ?? "guest").trim().toLowerCase();
  return CUSTOMER_PROFILES[normalizedId] ?? CUSTOMER_PROFILES.guest;
}

export function buildCartLines(items: CartItem[]): CheckoutLine[] {
  return items.map((item) => {
    const product = PRODUCT_CATALOG[item.sku];
    if (product === undefined) throw new Error(`Unknown product sku: ${item.sku}`);
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
      throw new Error(`Invalid quantity for ${item.sku}: ${item.quantity}`);
    }
    return {
      sku: product.sku,
      name: product.name,
      quantity: item.quantity,
      unitPriceCents: product.unitPriceCents,
      lineSubtotalCents: product.unitPriceCents * item.quantity,
      taxable: product.taxable,
      fulfillmentType: product.fulfillmentType,
      weightOunces: product.weightOunces * item.quantity,
    };
  });
}

export function sumLineSubtotals(lines: CheckoutLine[]): number {
  return lines.reduce((total, line) => total + line.lineSubtotalCents, 0);
}

export function taxableSubtotal(lines: CheckoutLine[]): number {
  return lines.filter((line) => line.taxable).reduce((total, line) => total + line.lineSubtotalCents, 0);
}

export function reserveInventory(
  lines: CheckoutLine[],
  preferredRegion: CustomerProfile["preferredWarehouseRegion"],
): InventoryReservation[] {
  return lines.map((line) => {
    const product = PRODUCT_CATALOG[line.sku];
    if (product === undefined) throw new Error(`Unknown product sku: ${line.sku}`);
    return {
      sku: line.sku,
      quantity: line.quantity,
      region: line.fulfillmentType === "freight" ? "west" : preferredRegion,
      status: product.stockOnHand >= line.quantity ? "reserved" : "backordered",
    };
  });
}
