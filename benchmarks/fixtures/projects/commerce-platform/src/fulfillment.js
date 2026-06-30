import { hasBackorders } from "./inventory.js";

export function buildFulfillmentPlan({ destinationState, reservations, shipping }) {
  const warehouseHandoff = destinationState === "WA" ? "northwest-hub" : "standard-hub";
  const status = hasBackorders(reservations) ? "backordered" : "ready";
  return {
    carrier: selectCarrier({ shipping, status }),
    status,
    warehouseHandoff,
  };
}

export function canReleaseShipment(plan, payment) {
  return plan.status === "ready" && payment.authorization.approved === true;
}

export function selectCarrier({ shipping, status }) {
  if (status === "backordered") return "Pending Inventory";
  if (shipping.method === "freight") return "Freight Partner";
  if (shipping.method === "express") return "AirSwift";
  return "Parcel Standard";
}
