import type { CheckoutQuote } from "@commerce-platform/contracts";

import { formatCents } from "../format";

export interface OrderSummaryProps {
  quote: CheckoutQuote;
}

export function OrderSummary({ quote }: OrderSummaryProps) {
  const totalCents = quote.totals.totalCents;
  return (
    <section aria-label="Order summary">
      <dl>
        <div>
          <dt>Merchandise</dt>
          <dd>{formatCents(quote.totals.merchandiseSubtotalCents)}</dd>
        </div>
        <div>
          <dt>Shipping</dt>
          <dd>{formatCents(quote.totals.shippingCents)}</dd>
        </div>
        <div>
          <dt>Total</dt>
          <dd>Total {formatCents(totalCents)}</dd>
        </div>
      </dl>
    </section>
  );
}
