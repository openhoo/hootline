import { Router } from "express";

import { isValidTicketIntake } from "@support-desk/contracts";
import { intakeTicket } from "@support-desk/domain";

export const ticketRouter = Router();

ticketRouter.post("/", (req, res) => {
  const body = req.body;
  if (!isValidTicketIntake(body)) {
    return res.status(400).json({ error: "Invalid ticket intake" });
  }
  return res.status(201).json(intakeTicket(body));
});
