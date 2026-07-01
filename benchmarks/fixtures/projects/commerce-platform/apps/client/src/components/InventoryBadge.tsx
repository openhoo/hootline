import type { InventoryReservation, ProductDefinition } from "@commerce-platform/contracts";

export interface InventoryBadgeProps {
  product: ProductDefinition;
  reservation: InventoryReservation;
}

export function InventoryBadge({ product, reservation }: InventoryBadgeProps) {
  const status = reservation.status;
  const label = status === "reserved" ? "Reserved" : "Backordered";
  return (
    <span aria-label={`${product.name} inventory status`} data-status={status}>
      {label}
    </span>
  );
}
