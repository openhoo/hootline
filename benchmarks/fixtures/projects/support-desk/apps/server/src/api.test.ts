import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";

import { createSupportApp } from "./app";

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

async function startServer() {
  const app = createSupportApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server?.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP listener");
  return `http://127.0.0.1:${address.port}`;
}

describe("support api", () => {
  it("rejects malformed ticket intake payloads", async () => {
    const url = await startServer();
    const response = await fetch(`${url}/api/tickets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "T-200",
        requesterEmail: "not-an-email",
        subject: "Login help",
      }),
    });

    expect(response.status).toBe(400);
  });

  it("filters reporting by team and date window", async () => {
    const url = await startServer();
    const response = await fetch(
      `${url}/api/reporting?team=support&from=2026-01-15T00:00:00.000Z&to=2026-01-15T23:59:59.000Z`,
    );
    const body = await response.json();
    const emptyWindowResponse = await fetch(
      `${url}/api/reporting?team=billing&from=2026-01-15T00:00:00.000Z&to=2026-01-15T23:59:59.000Z`,
    );
    const emptyWindowBody = await emptyWindowResponse.json();

    expect(response.status).toBe(200);
    expect(body.total).toBe(1);
    expect(body.resolutionRate).toBe(1);
    expect(emptyWindowResponse.status).toBe(200);
    expect(emptyWindowBody.total).toBe(0);
  });
});
