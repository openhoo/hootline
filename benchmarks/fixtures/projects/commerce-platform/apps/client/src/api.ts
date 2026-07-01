import type { CheckoutQuote, CheckoutRequest } from "@commerce-platform/contracts";

export async function fetchCheckoutQuote(request: CheckoutRequest): Promise<CheckoutQuote> {
  const response = await fetch("/api/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw new Error(`Checkout quote failed with HTTP ${response.status}`);
  return response.json() as Promise<CheckoutQuote>;
}
