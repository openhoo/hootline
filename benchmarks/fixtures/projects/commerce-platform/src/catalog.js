export const PRODUCTS = Object.freeze({
  "coffee-beans": Object.freeze({
    sku: "coffee-beans",
    name: "House Coffee Beans",
    unitPriceCents: 3200,
    taxable: true,
    fulfillmentType: "physical",
    weightOunces: 12,
  }),
  "pour-over-kit": Object.freeze({
    sku: "pour-over-kit",
    name: "Pour-over Kit",
    unitPriceCents: 4800,
    taxable: true,
    fulfillmentType: "physical",
    weightOunces: 20,
  }),
  "digital-gift-card": Object.freeze({
    sku: "digital-gift-card",
    name: "Digital Gift Card",
    unitPriceCents: 2500,
    taxable: false,
    fulfillmentType: "digital",
    weightOunces: 0,
  }),
  "espresso-machine": Object.freeze({
    sku: "espresso-machine",
    name: "Countertop Espresso Machine",
    unitPriceCents: 12800,
    taxable: true,
    fulfillmentType: "physical",
    weightOunces: 96,
  }),
  "subscription-refill": Object.freeze({
    sku: "subscription-refill",
    name: "Monthly Coffee Refill",
    unitPriceCents: 2200,
    taxable: false,
    fulfillmentType: "service",
    weightOunces: 0,
  }),
});

export function buildCartLines(items) {
  return items.map((item) => {
    const product = PRODUCTS[item.sku];
    if (product === undefined) throw new Error(`Unknown SKU: ${item.sku}`);
    const lineSubtotalCents = product.unitPriceCents * item.quantity;
    return {
      sku: product.sku,
      name: product.name,
      quantity: item.quantity,
      unitPriceCents: product.unitPriceCents,
      lineSubtotalCents,
      taxable: product.taxable,
      fulfillmentType: product.fulfillmentType,
      weightOunces: product.weightOunces,
    };
  });
}

export function sumLineSubtotals(lines) {
  return lines.reduce((total, line) => total + line.lineSubtotalCents, 0);
}

export function taxableSubtotal(lines) {
  return lines.reduce((total, line) => total + (line.taxable ? line.lineSubtotalCents : 0), 0);
}

export function physicalWeightOunces(lines) {
  return lines.reduce((total, line) => {
    if (line.fulfillmentType !== "physical") return total;
    return total + line.weightOunces * line.quantity;
  }, 0);
}
