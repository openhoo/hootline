import assert from "node:assert/strict";
import test from "node:test";

import ciChannel from "../agent/channels/ci.ts";

test("CI webhook routes reject oversized bodies before signature verification", async () => {
  const route = ciChannel.routes.find((entry) => entry.path === "/eve/v1/ci/github");
  assert.ok(route !== undefined);

  const handler = route.handler as unknown as (
    req: Request,
    args: {
      send: () => Promise<never>;
      waitUntil: () => undefined;
    },
  ) => Promise<Response>;

  const response = await handler(
    new Request("http://localhost/eve/v1/ci/github", {
      body: "{}",
      headers: { "content-length": "1048577" },
      method: "POST",
    }),
    {
      send: async () => {
        throw new Error("send must not be called for oversized webhooks.");
      },
      waitUntil: () => undefined,
    },
  );

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "webhook_body_too_large",
    maxBytes: 1048576,
  });
});
