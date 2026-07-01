import { Router } from "express";

import { buildReportingSummary } from "../reporting-service";

export const reportingRouter = Router();

reportingRouter.get("/", (req, res) => {
  res.json(buildReportingSummary(req.query));
});
