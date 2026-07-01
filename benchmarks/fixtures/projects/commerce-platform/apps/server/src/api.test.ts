import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";

import { createCommerceApp } from "./app";

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

async function startServer() {
  const app = createCommerceApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server?.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP listener");
  return `http://127.0.0.1:${address.port}`;
}

describe("commerce api", () => {
  it("rejects checkout lines with invalid quantities", async () => {
    const url = await startServer();
    const response = await fetch(`${url}/api/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        destinationState: "OR",
        items: [{ sku: "coffee-beans", quantity: 0 }],
      }),
    });

    expect(response.status).toBe(400);
  });

  it("passes resolved customer tier into quote calculation", async () => {
    const url = await startServer();
    const response = await fetch(`${url}/api/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customerId: " Cafe-Alma ",
        destinationState: "OR",
        items: [{ sku: "coffee-beans", quantity: 1 }],
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.customer.id).toBe("cafe-alma");
    expect(body.totals.tierDiscountCents).toBe(160);
  });
});
