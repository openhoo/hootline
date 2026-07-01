import { OrderSummary } from "./components/OrderSummary";
import { InventoryBadge } from "./components/InventoryBadge";
import { buildQuoteCacheKey } from "./hooks/useQuotePreview";

import type { CheckoutQuote, ProductDefinition } from "@commerce-platform/contracts";

const demoProduct: ProductDefinition = {
  sku: "coffee-beans",
  name: "House Espresso Beans",
  unitPriceCents: 3200,
  taxable: true,
  fulfillmentType: "physical",
  weightOunces: 16,
  stockOnHand: 8,
};

const demoQuote: CheckoutQuote = {
  customer: {
    id: "guest",
    billingName: "Guest Checkout",
    tier: "retail",
    taxExempt: false,
    defaultDestinationState: "OR",
    preferredWarehouseRegion: "west",
  },
  items: [],
  inventoryReservations: [{ sku: "coffee-beans", quantity: 1, region: "west", status: "reserved" }],
  payment: { authorizationId: "guest:demo:3999", captured: false },
  shipping: { method: "standard", costCents: 799, freeShippingApplied: false, carrier: "Parcel Standard" },
  totals: {
    merchandiseSubtotalCents: 3200,
    promotionDiscountCents: 0,
    tierDiscountCents: 0,
    discountedSubtotalCents: 3200,
    shippingCents: 799,
    taxCents: 0,
    totalCents: 3999,
  },
};

export function App() {
  const cacheKey = buildQuoteCacheKey({
    customerId: "guest",
    items: [{ sku: "coffee-beans", quantity: 1 }],
    promotionCode: " coffee10 ",
  });

  return (
    <main>
      <h1>Commerce operations</h1>
      <OrderSummary quote={demoQuote} />
      <InventoryBadge product={demoProduct} reservation={demoQuote.inventoryReservations[0]} />
      <p data-testid="cache-key">{cacheKey}</p>
    </main>
  );
}
