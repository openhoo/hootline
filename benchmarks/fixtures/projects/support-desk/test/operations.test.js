import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMacro,
  createTicket,
  escalationReason,
  lookupCustomerPlan,
  shouldEscalate,
  suggestKnowledgeArticle,
} from "../src/index.js";

test("priority tickets escalate once their response window has elapsed", () => {
  const ticket = {
    ...createTicket({
      id: "T-200",
      requesterEmail: "vip@example.com",
      customerPlanId: "enterprise",
      subject: "Follow up",
    }),
    openedAt: "2026-01-15T10:00:00.000Z",
  };

  assert.equal(shouldEscalate(ticket, lookupCustomerPlan("enterprise"), "2026-01-15T15:00:00.000Z"), true);
  assert.equal(escalationReason(ticket, lookupCustomerPlan("enterprise")), "priority SLA");
});

test("knowledge suggestions prefer ticket tags before subject fallback", () => {
  const ticket = createTicket({
    id: "T-201",
    requesterEmail: "user@example.com",
    subject: "Cannot login",
    tags: [" billing "],
  });

  assert.equal(suggestKnowledgeArticle(ticket)?.id, "kb-billing-001");
});

test("macros update status and merge tags without duplicates", () => {
  const ticket = createTicket({
    id: "T-202",
    requesterEmail: "user@example.com",
    status: "open",
    tags: ["bug", "diagnostics-requested"],
  });
  const updated = applyMacro(ticket, "requestDiagnostics");

  assert.equal(updated.status, "waiting_on_customer");
  assert.deepEqual(updated.tags, ["bug", "diagnostics-requested"]);
});
