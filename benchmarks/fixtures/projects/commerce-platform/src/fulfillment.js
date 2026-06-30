import { hasBackorders } from "./inventory.js";

export function buildFulfillmentPlan({ destinationState, reservations, shipping }) {
  const warehouseHandoff = destinationState === "WA" ? "northwest-hub" : "standard-hub";
  const status = hasBackorders(reservations) ? "backordered" : "ready";
  return {
    carrier: shipping.method === "express" ? "AirSwift" : "Parcel Standard",
    status,
    warehouseHandoff,
  };
}

export function canReleaseShipment(plan, payment) {
  return plan.status === "ready" && payment.authorization.approved === true;
}
