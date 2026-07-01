import { Router } from "express";

import { isValidCheckoutRequest } from "@commerce-platform/contracts";

import { createCheckoutQuote } from "../checkout-service";

export const checkoutRouter = Router();

checkoutRouter.post("/", (req, res) => {
  const body = req.body;
  if (!isValidCheckoutRequest(body)) {
    return res.status(400).json({ error: "Invalid checkout request" });
  }

  try {
    return res.json(createCheckoutQuote(body));
  } catch (error) {
    return res.status(422).json({
      error: error instanceof Error ? error.message : "Unable to quote checkout",
    });
  }
});
