import { formatCents } from "./money.js";

export function buildInvoice({ customer, order }) {
  return [
    `Bill to ${customer.billingName}`,
    `Customer tier ${customer.tier}`,
    `Subtotal ${formatCents(order.totals.merchandiseSubtotalCents)}`,
    `Discounts -${formatCents(order.totals.discountCents)}`,
    `Shipping ${formatCents(order.totals.shippingCents)}`,
    `Tax ${formatCents(order.totals.taxCents)}`,
    `Amount due ${formatCents(order.totals.totalCents)}`,
  ].join("\n");
}

export function invoiceReference(customer, orderNumber) {
  return `${customer.id}:${String(orderNumber).padStart(6, "0")}`;
}
