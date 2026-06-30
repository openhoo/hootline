export const CUSTOMERS = Object.freeze({
  guest: Object.freeze({
    id: "guest",
    billingName: "Guest Customer",
    email: "guest@example.test",
    preferredWarehouseRegion: "west",
    shippingProfile: "retail",
    tier: "standard",
    taxExempt: false,
  }),
  "cafe-alma": Object.freeze({
    id: "cafe-alma",
    billingName: "Cafe Alma LLC",
    email: "ops@cafealma.example",
    preferredWarehouseRegion: "east",
    shippingProfile: "wholesale",
    tier: "wholesale",
    taxExempt: false,
  }),
  "nonprofit-roasters": Object.freeze({
    id: "nonprofit-roasters",
    billingName: "Nonprofit Roasters",
    email: "finance@nonprofit.example",
    preferredWarehouseRegion: "west",
    shippingProfile: "nonprofit",
    tier: "nonprofit",
    taxExempt: true,
  }),
});

export function resolveCustomer(customerId) {
  const normalizedId = String(customerId ?? "guest").trim().toLowerCase();
  return CUSTOMERS[normalizedId] ?? CUSTOMERS.guest;
}

export function customerTierLabel(customer) {
  if (customer.taxExempt) return "tax exempt";
  if (customer.tier === "wholesale") return "wholesale";
  return "standard";
}

export function customerTaxableSubtotal(customer, taxableSubtotalCents) {
  return customer.taxExempt ? 0 : taxableSubtotalCents;
}
