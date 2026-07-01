export type FulfillmentType = "physical" | "digital" | "freight";
export type ShippingServiceLevel = "standard" | "express" | "freight" | "digital";
export type CustomerTier = "retail" | "wholesale" | "nonprofit";
export type ReservationStatus = "reserved" | "backordered";

export interface CartItem {
  sku: string;
  quantity: number;
}

export interface ProductDefinition {
  sku: string;
  name: string;
  unitPriceCents: number;
  taxable: boolean;
  fulfillmentType: FulfillmentType;
  weightOunces: number;
  stockOnHand: number;
}

export interface CustomerProfile {
  id: string;
  billingName: string;
  tier: CustomerTier;
  taxExempt: boolean;
  defaultDestinationState: string;
  preferredWarehouseRegion: "east" | "west";
}

export interface CheckoutRequest {
  customerId?: string;
  destinationState: string;
  idempotencyKey?: string;
  items: CartItem[];
  promotionCode?: string;
  shippingServiceLevel?: string;
}

export interface CheckoutLine {
  sku: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  lineSubtotalCents: number;
  taxable: boolean;
  fulfillmentType: FulfillmentType;
  weightOunces: number;
}

export interface InventoryReservation {
  sku: string;
  quantity: number;
  region: "east" | "west";
  status: ReservationStatus;
}

export interface CheckoutQuote {
  customer: CustomerProfile;
  items: CheckoutLine[];
  inventoryReservations: InventoryReservation[];
  payment: {
    authorizationId: string;
    captured: boolean;
  };
  shipping: {
    method: ShippingServiceLevel;
    costCents: number;
    freeShippingApplied: boolean;
    carrier: string;
  };
  totals: {
    merchandiseSubtotalCents: number;
    promotionDiscountCents: number;
    tierDiscountCents: number;
    discountedSubtotalCents: number;
    shippingCents: number;
    taxCents: number;
    totalCents: number;
  };
}

export const PRODUCT_CATALOG: Record<string, ProductDefinition> = Object.freeze({
  "coffee-beans": Object.freeze({
    sku: "coffee-beans",
    name: "House Espresso Beans",
    unitPriceCents: 3200,
    taxable: true,
    fulfillmentType: "physical",
    weightOunces: 16,
    stockOnHand: 48,
  }),
  "pour-over-kit": Object.freeze({
    sku: "pour-over-kit",
    name: "Pour Over Starter Kit",
    unitPriceCents: 4800,
    taxable: true,
    fulfillmentType: "physical",
    weightOunces: 28,
    stockOnHand: 7,
  }),
  "espresso-machine": Object.freeze({
    sku: "espresso-machine",
    name: "Linea Home Espresso Machine",
    unitPriceCents: 124900,
    taxable: true,
    fulfillmentType: "freight",
    weightOunces: 580,
    stockOnHand: 1,
  }),
  "digital-gift-card": Object.freeze({
    sku: "digital-gift-card",
    name: "Digital Gift Card",
    unitPriceCents: 2500,
    taxable: false,
    fulfillmentType: "digital",
    weightOunces: 0,
    stockOnHand: 999,
  }),
});

export const CUSTOMER_PROFILES: Record<string, CustomerProfile> = Object.freeze({
  guest: Object.freeze({
    id: "guest",
    billingName: "Guest Checkout",
    tier: "retail",
    taxExempt: false,
    defaultDestinationState: "OR",
    preferredWarehouseRegion: "west",
  }),
  "cafe-alma": Object.freeze({
    id: "cafe-alma",
    billingName: "Cafe Alma LLC",
    tier: "wholesale",
    taxExempt: false,
    defaultDestinationState: "OR",
    preferredWarehouseRegion: "east",
  }),
  "nonprofit-roasters": Object.freeze({
    id: "nonprofit-roasters",
    billingName: "Nonprofit Roasters Collective",
    tier: "nonprofit",
    taxExempt: true,
    defaultDestinationState: "WA",
    preferredWarehouseRegion: "west",
  }),
});

export function isValidCheckoutRequest(input: unknown): input is CheckoutRequest {
  if (typeof input !== "object" || input === null) return false;
  const candidate = input as Partial<CheckoutRequest>;
  if (typeof candidate.destinationState !== "string" || candidate.destinationState.trim().length !== 2) {
    return false;
  }
  if (!Array.isArray(candidate.items) || candidate.items.length === 0) return false;
  return candidate.items.every(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      typeof item.sku === "string" &&
      item.sku.trim().length > 0 &&
      Number.isSafeInteger(item.quantity) &&
      item.quantity > 0,
  );
}
