import express from "express";

import { reportingRouter } from "./routes/reporting";
import { ticketRouter } from "./routes/tickets";

export function createSupportApp() {
  const app = express();
  app.use(express.json());
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use("/api/tickets", ticketRouter);
  app.use("/api/reporting", reportingRouter);
  return app;
}

export const app = createSupportApp();
