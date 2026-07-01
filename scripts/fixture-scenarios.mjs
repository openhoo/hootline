import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FULLSTACK_REQUIRED_FILES = Object.freeze([
  ".gitignore",
  ".hootline.yaml",
  "package.json",
  "bun.lock",
  "tsconfig.base.json",
  "apps/client/index.html",
  "apps/client/package.json",
  "apps/client/tsconfig.json",
  "apps/client/vite.config.ts",
  "apps/server/package.json",
  "apps/server/tsconfig.json",
  "packages/contracts/package.json",
  "packages/contracts/tsconfig.json",
  "packages/domain/package.json",
  "packages/domain/tsconfig.json",
  "packages/test-utils/package.json",
  "packages/test-utils/tsconfig.json",
]);

export const PROJECTS = Object.freeze({
  "commerce-platform": Object.freeze({
    id: "commerce-platform",
    name: "Commerce Platform",
    templatePath: "benchmarks/fixtures/projects/commerce-platform",
    requiredFiles: FULLSTACK_REQUIRED_FILES,
    verificationCommands: Object.freeze([
      "bun ci",
      "bun run verify",
    ]),
  }),
  "support-desk": Object.freeze({
    id: "support-desk",
    name: "Support Desk",
    templatePath: "benchmarks/fixtures/projects/support-desk",
    requiredFiles: FULLSTACK_REQUIRED_FILES,
    verificationCommands: Object.freeze([
      "bun ci",
      "bun run verify",
    ]),
  }),
});

export const DEFAULT_SCENARIO_ID = "commerce-domain-shipping-threshold";

export const SCENARIOS = [
  scenario({
    projectId: "commerce-platform",
    id: "commerce-client-server-totals",
    title: "client order summary renders the authoritative API total",
    complexity: "basic",
    tags: ["commerce", "client", "totals"],
    sourcePath: "apps/client/src/components/OrderSummary.tsx",
    passingText: "  const totalCents = quote.totals.totalCents;",
    failingText: "  const totalCents = quote.totals.merchandiseSubtotalCents;",
    commitMessage: "Reproduce failing commerce client total pipeline",
    expectedFailure: "renders the authoritative API total",
    expectedRepairFile: "apps/client/src/components/OrderSummary.tsx",
  }),
  scenario({
    projectId: "commerce-platform",
    id: "commerce-client-promo-cache-key",
    title: "client quote cache keys normalize promotion codes",
    complexity: "basic",
    tags: ["commerce", "client", "promotions", "cache"],
    sourcePath: "apps/client/src/hooks/useQuotePreview.ts",
    passingText: '  const normalizedPromotionCode = String(promotionCode ?? "").trim().toUpperCase();',
    failingText: '  const normalizedPromotionCode = String(promotionCode ?? "").trim();',
    commitMessage: "Reproduce failing commerce promo cache pipeline",
    expectedFailure: "normalizes promotion codes in quote cache keys",
    expectedRepairFile: "apps/client/src/hooks/useQuotePreview.ts",
  }),
  scenario({
    projectId: "commerce-platform",
    id: "commerce-client-inventory-warning",
    title: "client inventory badges use reservation status",
    complexity: "basic",
    tags: ["commerce", "client", "inventory"],
    sourcePath: "apps/client/src/components/InventoryBadge.tsx",
    passingText: "  const status = reservation.status;",
    failingText: '  const status = product.stockOnHand > 0 ? "reserved" : "backordered";',
    commitMessage: "Reproduce failing commerce inventory badge pipeline",
    expectedFailure: "uses reservation status for inventory badges",
    expectedRepairFile: "apps/client/src/components/InventoryBadge.tsx",
  }),
  scenario({
    projectId: "commerce-platform",
    id: "commerce-api-checkout-quantity-validation",
    title: "checkout API rejects invalid line quantities",
    complexity: "intermediate",
    tags: ["commerce", "api", "validation"],
    sourcePath: "apps/server/src/routes/checkout.ts",
    passingText: `  if (!isValidCheckoutRequest(body)) {
    return res.status(400).json({ error: "Invalid checkout request" });
  }`,
    failingText: `  if (!Array.isArray(body?.items)) {
    return res.status(400).json({ error: "Invalid checkout request" });
  }`,
    commitMessage: "Reproduce failing commerce checkout validation pipeline",
    expectedFailure: "rejects checkout lines with invalid quantities",
    expectedRepairFile: "apps/server/src/routes/checkout.ts",
  }),
  scenario({
    projectId: "commerce-platform",
    id: "commerce-api-customer-tier-pricing",
    title: "checkout API passes resolved customer tier into pricing",
    complexity: "intermediate",
    tags: ["commerce", "api", "pricing", "customers"],
    sourcePath: "apps/server/src/checkout-service.ts",
    passingText: "  const quote = quoteOrder({ ...request, customerId: customer.id, customerTier: customer.tier });",
    failingText: '  const quote = quoteOrder({ ...request, customerId: customer.id, customerTier: "retail" });',
    commitMessage: "Reproduce failing commerce customer tier pipeline",
    expectedFailure: "passes resolved customer tier into quote calculation",
    expectedRepairFile: "apps/server/src/checkout-service.ts",
  }),
  scenario({
    projectId: "commerce-platform",
    id: "commerce-domain-shipping-threshold",
    title: "free shipping uses pre-discount merchandise subtotal",
    complexity: "basic",
    tags: ["commerce", "domain", "shipping", "discounts"],
    sourcePath: "packages/domain/src/shipping.ts",
    passingText: "  const shippingBasisCents = merchandiseSubtotalCents;",
    failingText: "  const shippingBasisCents = discountedSubtotalCents;",
    commitMessage: "Reproduce failing commerce shipping threshold pipeline",
    expectedFailure: "quotes free shipping from merchandise subtotal before promotions",
    expectedRepairFile: "packages/domain/src/shipping.ts",
  }),
  scenario({
    projectId: "commerce-platform",
    id: "commerce-domain-destination-tax",
    title: "sales tax uses the destination state's configured rate",
    complexity: "basic",
    tags: ["commerce", "domain", "tax"],
    sourcePath: "packages/domain/src/tax.ts",
    passingText: "  const taxRatePercent = TAX_RATES_BY_STATE[state];",
    failingText: "  const taxRatePercent = TAX_RATES_BY_STATE.OR;",
    commitMessage: "Reproduce failing commerce destination tax pipeline",
    expectedFailure: "uses the destination state tax rate",
    expectedRepairFile: "packages/domain/src/tax.ts",
  }),
  scenario({
    projectId: "commerce-platform",
    id: "commerce-domain-payment-idempotency",
    title: "payment authorization normalizes idempotency inputs",
    complexity: "basic",
    tags: ["commerce", "domain", "payments"],
    sourcePath: "packages/domain/src/payments.ts",
    passingText: "  const normalizedKey = String(input.idempotencyKey).trim().toLowerCase();",
    failingText: "  const normalizedKey = String(input.idempotencyKey).trim();",
    commitMessage: "Reproduce failing commerce payment idempotency pipeline",
    expectedFailure: "preserves payment idempotency across customer and key case",
    expectedRepairFile: "packages/domain/src/payments.ts",
  }),
  scenario({
    projectId: "commerce-platform",
    id: "commerce-contract-digital-gift-card",
    title: "digital gift cards remain non-taxable and non-shippable",
    complexity: "intermediate",
    tags: ["commerce", "contracts", "catalog", "tax"],
    sourcePath: "packages/contracts/src/index.ts",
    passingText: `  "digital-gift-card": Object.freeze({
    sku: "digital-gift-card",
    name: "Digital Gift Card",
    unitPriceCents: 2500,
    taxable: false,
    fulfillmentType: "digital",
    weightOunces: 0,
    stockOnHand: 999,
  }),`,
    failingText: `  "digital-gift-card": Object.freeze({
    sku: "digital-gift-card",
    name: "Digital Gift Card",
    unitPriceCents: 2500,
    taxable: true,
    fulfillmentType: "physical",
    weightOunces: 1,
    stockOnHand: 999,
  }),`,
    commitMessage: "Reproduce failing commerce digital gift card pipeline",
    expectedFailure: "keeps digital gift cards non-taxable and non-shippable",
    expectedRepairFile: "packages/contracts/src/index.ts",
  }),
  scenario({
    projectId: "commerce-platform",
    id: "commerce-checkout-cascade",
    title: "checkout survives promotion, shipping, and tax regressions together",
    complexity: "complex",
    tags: ["commerce", "domain", "promotions", "shipping", "tax", "multi-file"],
    mutations: [
      {
        sourcePath: "packages/domain/src/pricing.ts",
        passingText: '  const normalizedCode = String(promotionCode).trim().toUpperCase();',
        failingText: '  const normalizedCode = String(promotionCode).trim();',
      },
      {
        sourcePath: "packages/domain/src/shipping.ts",
        passingText: "  const shippingBasisCents = merchandiseSubtotalCents;",
        failingText: "  const shippingBasisCents = discountedSubtotalCents;",
      },
      {
        sourcePath: "packages/domain/src/tax.ts",
        passingText: "  const taxRatePercent = TAX_RATES_BY_STATE[state];",
        failingText: "  const taxRatePercent = TAX_RATES_BY_STATE.OR;",
      },
    ],
    commitMessage: "Reproduce failing commerce checkout cascade pipeline",
    expectedFailure: "promo, shipping, and tax cascade regressions",
    expectedRepairFiles: [
      "packages/domain/src/pricing.ts",
      "packages/domain/src/shipping.ts",
      "packages/domain/src/tax.ts",
    ],
  }),
  scenario({
    projectId: "support-desk",
    id: "support-client-email-normalization",
    title: "client ticket drafts normalize requester emails",
    complexity: "basic",
    tags: ["support", "client", "tickets", "input-normalization"],
    sourcePath: "apps/client/src/ticket-draft.ts",
    passingText: "    requesterEmail: input.requesterEmail.trim().toLowerCase(),",
    failingText: "    requesterEmail: input.requesterEmail.trim(),",
    commitMessage: "Reproduce failing support email normalization pipeline",
    expectedFailure: "normalizes requester email in ticket drafts",
    expectedRepairFile: "apps/client/src/ticket-draft.ts",
  }),
  scenario({
    projectId: "support-desk",
    id: "support-client-incident-priority",
    title: "client queue cards show incident priority before plan priority",
    complexity: "basic",
    tags: ["support", "client", "routing", "incidents"],
    sourcePath: "apps/client/src/components/QueueCard.tsx",
    passingText: `  const displayQueue =
    result.ticket.severity === "critical"
      ? "incident"
      : result.customerPlan.prioritySupport
        ? "priority"
        : result.assignment.queue;`,
    failingText: `  const displayQueue =
    result.customerPlan.prioritySupport
      ? "priority"
      : result.ticket.severity === "critical"
        ? "incident"
        : result.assignment.queue;`,
    commitMessage: "Reproduce failing support incident priority UI pipeline",
    expectedFailure: "renders incident priority ahead of enterprise plan priority",
    expectedRepairFile: "apps/client/src/components/QueueCard.tsx",
  }),
  scenario({
    projectId: "support-desk",
    id: "support-client-localized-notification",
    title: "client notification previews preserve localized subjects",
    complexity: "basic",
    tags: ["support", "client", "notifications", "localization"],
    sourcePath: "apps/client/src/components/NotificationPreview.tsx",
    passingText: "  const subject = notification.subject;",
    failingText: '  const subject = notification.subject.replace(/^Anfrage/, "Request");',
    commitMessage: "Reproduce failing support localized notification UI pipeline",
    expectedFailure: "renders localized notification previews",
    expectedRepairFile: "apps/client/src/components/NotificationPreview.tsx",
  }),
  scenario({
    projectId: "support-desk",
    id: "support-api-ticket-validation",
    title: "ticket API rejects malformed intake payloads",
    complexity: "intermediate",
    tags: ["support", "api", "validation"],
    sourcePath: "apps/server/src/routes/tickets.ts",
    passingText: `  if (!isValidTicketIntake(body)) {
    return res.status(400).json({ error: "Invalid ticket intake" });
  }`,
    failingText: `  if (typeof body?.id !== "string") {
    return res.status(400).json({ error: "Invalid ticket intake" });
  }`,
    commitMessage: "Reproduce failing support ticket validation pipeline",
    expectedFailure: "rejects malformed ticket intake payloads",
    expectedRepairFile: "apps/server/src/routes/tickets.ts",
  }),
  scenario({
    projectId: "support-desk",
    id: "support-api-reporting-window",
    title: "reporting API filters by team and date window",
    complexity: "intermediate",
    tags: ["support", "api", "reporting"],
    sourcePath: "apps/server/src/reporting-service.ts",
    passingText: "  return summarizeTickets(REPORTING_SEED, { from, team, to });",
    failingText:
      '  return summarizeTickets(REPORTING_SEED, { from: "2026-01-01T00:00:00.000Z", team, to: "2026-12-31T23:59:59.000Z" });',
    commitMessage: "Reproduce failing support reporting window pipeline",
    expectedFailure: "filters reporting by team and date window",
    expectedRepairFile: "apps/server/src/reporting-service.ts",
  }),
  scenario({
    projectId: "support-desk",
    id: "support-domain-plan-fallback",
    title: "unknown plans fall back to free support",
    complexity: "basic",
    tags: ["support", "domain", "plans", "fallbacks"],
    sourcePath: "packages/domain/src/plans.ts",
    passingText: "  return CUSTOMER_PLANS[normalizedId] ?? CUSTOMER_PLANS.free;",
    failingText: "  return CUSTOMER_PLANS[normalizedId] ?? CUSTOMER_PLANS.enterprise;",
    commitMessage: "Reproduce failing support plan fallback pipeline",
    expectedFailure: "falls back unknown customer plans to free support",
    expectedRepairFile: "packages/domain/src/plans.ts",
  }),
  scenario({
    projectId: "support-desk",
    id: "support-domain-critical-routing",
    title: "critical tickets route to incident response before plan routing",
    complexity: "basic",
    tags: ["support", "domain", "routing", "incidents"],
    sourcePath: "packages/domain/src/routing.ts",
    passingText: '  if (ticket.severity === "critical") return { queue: "incident", ownerTeam: "incident-response" };',
    failingText: '  if (ticket.severity === "critical") return { queue: "priority", ownerTeam: "senior-support" };',
    commitMessage: "Reproduce failing support critical routing pipeline",
    expectedFailure: "routes critical tickets to incident response before plan routing",
    expectedRepairFile: "packages/domain/src/routing.ts",
  }),
  scenario({
    projectId: "support-desk",
    id: "support-domain-weekend-sla",
    title: "weekend tickets include weekend SLA delay",
    complexity: "intermediate",
    tags: ["support", "domain", "sla", "time"],
    sourcePath: "packages/domain/src/sla.ts",
    passingText: "  const dueHours = policy.responseHours + weekendDelayHours(openedAt);",
    failingText: "  const dueHours = policy.responseHours;",
    commitMessage: "Reproduce failing support weekend SLA pipeline",
    expectedFailure: "adds weekend delay to ticket deadlines",
    expectedRepairFile: "packages/domain/src/sla.ts",
  }),
  scenario({
    projectId: "support-desk",
    id: "support-domain-audit-redaction",
    title: "audit events redact internal notes",
    complexity: "intermediate",
    tags: ["support", "domain", "audit", "privacy"],
    sourcePath: "packages/domain/src/audit.ts",
    passingText: "    internalNote: undefined,",
    failingText: "    internalNote: event.internalNote,",
    commitMessage: "Reproduce failing support audit redaction pipeline",
    expectedFailure: "redacts internal audit notes",
    expectedRepairFile: "packages/domain/src/audit.ts",
  }),
  scenario({
    projectId: "support-desk",
    id: "support-triage-cascade",
    title: "requester profiles preserve plan inference, billing routing, and localized notifications",
    complexity: "complex",
    tags: ["support", "domain", "requesters", "routing", "notifications", "multi-file"],
    mutations: [
      {
        sourcePath: "packages/domain/src/workflow.ts",
        passingText: '  const customerPlanId = input.customerPlanId ?? requesterProfile?.customerPlanId ?? "free";',
        failingText: '  const customerPlanId = input.customerPlanId ?? "free";',
      },
      {
        sourcePath: "packages/domain/src/routing.ts",
        passingText: `  if (ticket.tags.includes("billing")) return { queue: "billing", ownerTeam: "billing" };
  if (customerPlan.prioritySupport) return { queue: "priority", ownerTeam: "senior-support" };`,
        failingText: `  if (customerPlan.prioritySupport) return { queue: "priority", ownerTeam: "senior-support" };
  if (ticket.tags.includes("billing")) return { queue: "billing", ownerTeam: "billing" };`,
      },
      {
        sourcePath: "packages/domain/src/notifications.ts",
        passingText: '  const prefix = SUBJECT_PREFIX_BY_LOCALE[locale] ?? SUBJECT_PREFIX_BY_LOCALE["en-US"];',
        failingText: '  const prefix = SUBJECT_PREFIX_BY_LOCALE["en-US"];',
      },
    ],
    commitMessage: "Reproduce failing support triage cascade pipeline",
    expectedFailure: "requester profiles drive plan inference, billing routing, and localized notifications",
    expectedRepairFiles: [
      "packages/domain/src/workflow.ts",
      "packages/domain/src/routing.ts",
      "packages/domain/src/notifications.ts",
    ],
  }),
];

export function projectIds() {
  return Object.keys(PROJECTS);
}

export function resolveProjects(selection = "all") {
  if (selection === "all") return projectIds().map((id) => PROJECTS[id]);
  const ids = selection
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (ids.length === 0) throw new Error("At least one project id is required.");
  return ids.map((id) => {
    const project = PROJECTS[id];
    if (project === undefined) {
      throw new Error(`Unknown fixture project '${id}'. Available projects: ${projectIds().join(", ")}`);
    }
    return project;
  });
}

export function scenarioIds(scenarios = SCENARIOS) {
  return scenarios.map((scenario) => scenario.id);
}

export function resolveScenario(id = DEFAULT_SCENARIO_ID) {
  const scenario = SCENARIOS.find((entry) => entry.id === id);
  if (scenario === undefined) {
    throw new Error(`Unknown fixture scenario '${id}'. Available scenarios: ${scenarioIds().join(", ")}`);
  }
  return scenario;
}

export function resolveScenarios(selection = "all", options = {}) {
  const projectSelection = options.projects ?? "all";
  const selectedProjectIds = new Set(resolveProjects(projectSelection).map((project) => project.id));
  const candidateScenarios = SCENARIOS.filter((scenario) => selectedProjectIds.has(scenario.projectId));
  if (selection === "all") return [...candidateScenarios];
  const ids = selection
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (ids.length === 0) throw new Error("At least one scenario id is required.");
  return ids.map((id) => {
    const scenario = candidateScenarios.find((entry) => entry.id === id);
    if (scenario === undefined) {
      throw new Error(
        `Unknown fixture scenario '${id}' for project selection '${projectSelection}'. Available scenarios: ${scenarioIds(candidateScenarios).join(", ")}`,
      );
    }
    return scenario;
  });
}

export function scenarioMutations(scenario) {
  if (Array.isArray(scenario.mutations) && scenario.mutations.length > 0) {
    return scenario.mutations;
  }
  return [
    {
      sourcePath: scenario.sourcePath,
      passingText: scenario.passingText,
      failingText: scenario.failingText,
    },
  ];
}

export function scenarioSourcePaths(scenario) {
  return unique(scenarioMutations(scenario).map((mutation) => mutation.sourcePath));
}

export function scenarioExpectedRepairFiles(scenario) {
  return unique(scenario.expectedRepairFiles ?? [scenario.expectedRepairFile]);
}

export function expectedFixtureFiles(scenarios = SCENARIOS) {
  const projects = unique(scenarios.map((scenario) => scenario.projectId)).map((id) => PROJECTS[id]);
  return [
    ...projects.flatMap((project) =>
      project.requiredFiles.map((relativePath) => `${project.templatePath}/${relativePath}`),
    ),
    ...scenarios.flatMap((scenario) =>
      scenarioSourcePaths(scenario).map((sourcePath) => `${scenario.templatePath}/${sourcePath}`),
    ),
  ].filter((file, index, files) => files.indexOf(file) === index);
}

export function assertScenarioBaseline(fixturePath, scenario) {
  for (const mutation of scenarioMutations(scenario)) {
    const sourcePath = join(fixturePath, mutation.sourcePath);
    if (!existsSync(sourcePath)) {
      throw new Error(`Baseline is missing scenario source file: ${mutation.sourcePath}`);
    }
    const source = readFileSync(sourcePath, "utf8");
    assertExactOccurrence(source, mutation.passingText, mutation.sourcePath, "passing text");
    if (source.includes(mutation.failingText)) {
      throw new Error(`Baseline ${mutation.sourcePath} already contains failing text for ${scenario.id}.`);
    }
  }
}

export function applyScenarioMutation(fixturePath, scenario) {
  const sources = new Map();
  for (const mutation of scenarioMutations(scenario)) {
    const sourcePath = join(fixturePath, mutation.sourcePath);
    const source = sources.get(sourcePath) ?? readFileSync(sourcePath, "utf8");
    assertExactOccurrence(source, mutation.passingText, mutation.sourcePath, "passing text");
    sources.set(sourcePath, source.replace(mutation.passingText, () => mutation.failingText));
  }
  for (const [sourcePath, source] of sources) {
    writeFileSync(sourcePath, source);
  }
}

function assertExactOccurrence(source, needle, path, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) {
    throw new Error(`${path} must contain ${label} exactly once; found ${count}.`);
  }
}

function scenario(input) {
  const project = PROJECTS[input.projectId];
  if (project === undefined) throw new Error(`Unknown project id for scenario ${input.id}: ${input.projectId}`);
  const mutations =
    input.mutations ??
    [
      {
        sourcePath: input.sourcePath,
        passingText: input.passingText,
        failingText: input.failingText,
      },
    ];
  const repairFiles = unique(input.expectedRepairFiles ?? [input.expectedRepairFile ?? mutations[0].sourcePath]);
  return {
    ...input,
    projectId: project.id,
    projectName: project.name,
    templatePath: project.templatePath,
    verificationCommands: [...project.verificationCommands],
    sourcePath: input.sourcePath ?? mutations[0].sourcePath,
    passingText: input.passingText ?? mutations[0].passingText,
    failingText: input.failingText ?? mutations[0].failingText,
    expectedRepairFile: input.expectedRepairFile ?? repairFiles[0],
    expectedRepairFiles: repairFiles,
    mutations,
  };
}

function unique(values) {
  return values.filter((value, index, list) => value !== undefined && list.indexOf(value) === index);
}
