const STOCK_BY_REGION = Object.freeze({
  west: Object.freeze({
    "coffee-beans": 120,
    "pour-over-kit": 12,
    "digital-gift-card": 9999,
    "espresso-machine": 1,
    "subscription-refill": 9999,
  }),
  east: Object.freeze({
    "coffee-beans": 60,
    "pour-over-kit": 4,
    "digital-gift-card": 9999,
    "espresso-machine": 0,
    "subscription-refill": 9999,
  }),
});

export function reserveInventory(lines, region = "west") {
  const stock = STOCK_BY_REGION[region] ?? STOCK_BY_REGION.west;
  return lines.map((line) => {
    const available = stock[line.sku] ?? 0;
    const status = available >= line.quantity ? "reserved" : "backordered";
    return {
      sku: line.sku,
      requested: line.quantity,
      available,
      region,
      status,
    };
  });
}

export function hasBackorders(reservations) {
  return reservations.some((reservation) => reservation.status === "backordered");
}
