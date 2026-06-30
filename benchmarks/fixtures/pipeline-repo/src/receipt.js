import { formatCents } from "./money.js";

export function buildReceipt(order) {
  return [
    "Receipt",
    ...order.lines.map((line) => `${line.quantity}x ${line.name} ${formatCents(line.lineSubtotalCents)}`),
    `Subtotal ${formatCents(order.totals.merchandiseSubtotalCents)}`,
    `Discount -${formatCents(order.totals.discountCents)}`,
    `Shipping ${formatCents(order.totals.shippingCents)}`,
    `Tax ${formatCents(order.totals.taxCents)}`,
    `Total ${formatCents(order.totals.totalCents)}`,
  ].join("\n");
}
