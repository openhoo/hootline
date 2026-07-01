import { Router } from "express";

import { PRODUCT_CATALOG } from "@commerce-platform/contracts";

export const catalogRouter = Router();

catalogRouter.get("/", (_req, res) => {
  res.json({ products: Object.values(PRODUCT_CATALOG) });
});
