import express from "express";

import { checkoutRouter } from "./routes/checkout";
import { catalogRouter } from "./routes/catalog";

export function createCommerceApp() {
  const app = express();
  app.use(express.json());
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use("/api/catalog", catalogRouter);
  app.use("/api/checkout", checkoutRouter);
  return app;
}

export const app = createCommerceApp();
