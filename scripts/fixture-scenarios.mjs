import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PROJECTS = Object.freeze({
  "commerce-platform": Object.freeze({
    id: "commerce-platform",
    name: "Commerce Platform",
    templatePath: "benchmarks/fixtures/projects/commerce-platform",
    verificationCommands: Object.freeze(["npm test"]),
  }),
  "support-desk": Object.freeze({
    id: "support-desk",
    name: "Support Desk",
    templatePath: "benchmarks/fixtures/projects/support-desk",
    verificationCommands: Object.freeze(["npm test"]),
  }),
});

export const DEFAULT_SCENARIO_ID = "shipping-threshold-basis";

export const SCENARIOS = [
  scenario({
    projectId: "commerce-platform",
    id: "shipping-threshold-basis",
    title: "free shipping uses pre-discount merchandise subtotal",
    complexity: "basic",
    tags: ["commerce", "shipping", "discounts"],
    sourcePath: "src/shipping.js",
    passingText: "  const shippingBasisCents = merchandiseSubtotalCents;",
    failingText: "  const shippingBasisCents = discountedSubtotalCents;",
    commitMessage: "Reproduce failing shipping threshold pipeline",
    expectedFailure: "free shipping based on merchandise subtotal",
    expectedRepairFile: "src/shipping.js",
  }),
  scenario({
    projectId: "commerce-platform",
    id: "promotion-code-normalization",
    title: "promotion lookup normalizes customer-entered codes",
    complexity: "basic",
    tags: ["commerce", "promotions", "input-normalization"],
    sourcePath: "src/promotions.js",
    passingText: "  const normalizedCode = String(promotionCode).trim().toUpperCase();",
    failingText: "  const normalizedCode = String(promotionCode).trim();",
    commitMessage: "Reproduce failing promotion normalization pipeline",
    expectedFailure: "normalizes promotion codes",
    expectedRepairFile: "src/promotions.js",
  }),
  scenario({
    projectId: "commerce-platform",
    id: "unknown-promotion-no-discount",
    title: "unknown promotion codes do not create discounts",
    complexity: "basic",
    tags: ["commerce", "promotions", "fallbacks"],
    sourcePath: "src/promotions.js",
    passingText: "  return PROMOTIONS[normalizedCode] ?? null;",
    failingText: "  return PROMOTIONS[normalizedCode] ?? PROMOTIONS.COFFEE10;",
    commitMessage: "Reproduce failing unknown promotion pipeline",
    expectedFailure: "unknown promotion codes do not create discounts",
    expectedRepairFile: "src/promotions.js",
  }),
  scenario({
    projectId: "commerce-platform",
    id: "mixed-cart-shipping",
    title: "mixed physical and digital carts still need physical shipping",
    complexity: "basic",
    tags: ["commerce", "shipping", "cart-classification"],
    sourcePath: "src/checkout.js",
    passingText: "  const allDigital = lines.every((line) => line.weightOunces === 0);",
    failingText: "  const allDigital = lines.some((line) => line.weightOunces === 0);",
    commitMessage: "Reproduce failing mixed-cart shipping pipeline",
    expectedFailure: "mixed physical and digital carts",
    expectedRepairFile: "src/checkout.js",
  }),
  scenario({
    projectId: "commerce-platform",
    id: "percentage-rounding",
    title: "percentage money math rounds to the nearest cent",
    complexity: "basic",
    tags: ["commerce", "money", "rounding"],
    sourcePath: "src/money.js",
    passingText: "  return Math.round((cents * percent) / 100);",
    failingText: "  return Math.floor((cents * percent) / 100);",
    commitMessage: "Reproduce failing percentage rounding pipeline",
    expectedFailure: "rounds percentage calculations",
    expectedRepairFile: "src/money.js",
  }),
  scenario({
    projectId: "commerce-platform",
    id: "express-shipping-not-free",
    title: "express shipping is never made free by the standard threshold",
    complexity: "intermediate",
    tags: ["commerce", "shipping", "service-level"],
    sourcePath: "src/shipping.js",
    passingText: `  const freeShippingApplied =
    service.method === "standard" && shippingBasisCents >= FREE_SHIPPING_THRESHOLD_CENTS;`,
    failingText: `  const freeShippingApplied =
    shippingBasisCents >= FREE_SHIPPING_THRESHOLD_CENTS;`,
    commitMessage: "Reproduce failing express shipping pipeline",
    expectedFailure: "express shipping even when standard shipping would be free",
    expectedRepairFile: "src/shipping.js",
  }),
  scenario({
    projectId: "commerce-platform",
    id: "unknown-shipping-service-defaults-standard",
    title: "unknown shipping service levels fall back to standard shipping",
    complexity: "intermediate",
    tags: ["commerce", "shipping", "fallbacks"],
    sourcePath: "src/shipping.js",
    passingText: "  const service = SHIPPING_RATES[requestedService] ?? SHIPPING_RATES.standard;",
    failingText: "  const service = SHIPPING_RATES[requestedService];",
    commitMessage: "Reproduce failing unknown shipping service pipeline",
    expectedFailure: "unknown shipping service levels fall back to standard shipping",
    expectedRepairFile: "src/shipping.js",
  }),
  scenario({
    projectId: "commerce-platform",
    id: "digital-gift-card-tax-exemption",
    title: "digital gift cards stay non-taxable",
    complexity: "intermediate",
    tags: ["commerce", "catalog", "tax"],
    sourcePath: "src/catalog.js",
    passingText: `  "digital-gift-card": Object.freeze({
    sku: "digital-gift-card",
    name: "Digital Gift Card",
    unitPriceCents: 2500,
    taxable: false,
    fulfillmentType: "digital",
    weightOunces: 0,
  }),`,
    failingText: `  "digital-gift-card": Object.freeze({
    sku: "digital-gift-card",
    name: "Digital Gift Card",
    unitPriceCents: 2500,
    taxable: true,
    fulfillmentType: "digital",
    weightOunces: 0,
  }),`,
    commitMessage: "Reproduce failing digital gift card tax pipeline",
    expectedFailure: "digital gift cards stay non-taxable",
    expectedRepairFile: "src/catalog.js",
  }),
  scenario({
    projectId: "commerce-platform",
    id: "cart-line-quantity-subtotal",
    title: "cart line subtotals multiply unit price by quantity",
    complexity: "intermediate",
    tags: ["commerce", "catalog", "totals"],
    sourcePath: "src/catalog.js",
    passingText: "    const lineSubtotalCents = product.unitPriceCents * item.quantity;",
    failingText: "    const lineSubtotalCents = product.unitPriceCents;",
    commitMessage: "Reproduce failing cart quantity subtotal pipeline",
    expectedFailure: "cart line subtotals multiply unit price by quantity",
    expectedRepairFile: "src/catalog.js",
  }),
  scenario({
    projectId: "commerce-platform",
    id: "receipt-total-line",
    title: "receipt total line includes shipping and tax",
    complexity: "intermediate",
    tags: ["commerce", "receipt", "totals"],
    sourcePath: "src/receipt.js",
    passingText: "    `Total ${formatCents(order.totals.totalCents)}`,",
    failingText: "    `Total ${formatCents(order.totals.discountedSubtotalCents)}`,",
    commitMessage: "Reproduce failing receipt total pipeline",
    expectedFailure: "receipt total line includes shipping and tax",
    expectedRepairFile: "src/receipt.js",
  }),
  scenario({
    projectId: "commerce-platform",
    id: "tax-rate-state-lookup",
    title: "tax calculation uses the destination state's configured rate",
    complexity: "intermediate",
    tags: ["commerce", "tax", "destination"],
    sourcePath: "src/tax.js",
    passingText: "  const taxRatePercent = TAX_RATES_BY_STATE[state];",
    failingText: "  const taxRatePercent = TAX_RATES_BY_STATE.OR;",
    commitMessage: "Reproduce failing destination tax lookup pipeline",
    expectedFailure: "tax calculation uses destination state",
    expectedRepairFile: "src/tax.js",
  }),
  scenario({
    projectId: "commerce-platform",
    id: "checkout-money-shipping-tax-cascade",
    title: "checkout totals survive simultaneous money, shipping, and tax regressions",
    complexity: "complex",
    tags: ["commerce", "money", "shipping", "tax", "multi-file"],
    mutations: [
      {
        sourcePath: "src/money.js",
        passingText: "  return Math.round((cents * percent) / 100);",
        failingText: "  return Math.floor((cents * percent) / 100);",
      },
      {
        sourcePath: "src/shipping.js",
        passingText: "  const shippingBasisCents = merchandiseSubtotalCents;",
        failingText: "  const shippingBasisCents = discountedSubtotalCents;",
      },
      {
        sourcePath: "src/tax.js",
        passingText: "  const taxRatePercent = TAX_RATES_BY_STATE[state];",
        failingText: "  const taxRatePercent = TAX_RATES_BY_STATE.OR;",
      },
    ],
    commitMessage: "Reproduce failing checkout money shipping tax cascade",
    expectedFailure: "promoted order with free shipping",
    expectedRepairFiles: ["src/money.js", "src/shipping.js", "src/tax.js"],
  }),
  scenario({
    projectId: "commerce-platform",
    id: "account-aware-fulfillment-cascade",
    title: "account-aware checkout preserves tax exemption, freight carrier, and payment idempotency",
    complexity: "complex",
    tags: ["commerce", "customers", "tax", "fulfillment", "payments", "multi-file"],
    mutations: [
      {
        sourcePath: "src/checkout.js",
        passingText: `  const taxableBasisCents = customerTaxableSubtotal(customer, taxableSubtotal(lines));
  const taxCents = calculateTaxCents(taxableBasisCents, destinationState);`,
        failingText: "  const taxCents = calculateTaxCents(taxableSubtotal(lines), destinationState);",
      },
      {
        sourcePath: "src/fulfillment.js",
        passingText: '  if (shipping.method === "freight") return "Freight Partner";',
        failingText: '  if (shipping.method === "freight") return "Parcel Standard";',
      },
      {
        sourcePath: "src/payments.js",
        passingText: "  const normalizedKey = String(idempotencyKey).trim().toLowerCase();",
        failingText: "  const normalizedKey = String(idempotencyKey).trim();",
      },
    ],
    commitMessage: "Reproduce failing account-aware fulfillment cascade",
    expectedFailure: "tax exempt customers, freight fulfillment, and normalized payment idempotency",
    expectedRepairFiles: ["src/checkout.js", "src/fulfillment.js", "src/payments.js"],
  }),
  scenario({
    projectId: "support-desk",
    id: "ticket-email-normalization",
    title: "ticket intake normalizes requester email addresses",
    complexity: "basic",
    tags: ["support", "tickets", "input-normalization"],
    sourcePath: "src/tickets.js",
    passingText: "  const requesterEmail = String(input.requesterEmail).trim().toLowerCase();",
    failingText: "  const requesterEmail = String(input.requesterEmail).trim();",
    commitMessage: "Reproduce failing requester email normalization pipeline",
    expectedFailure: "ticket intake normalizes requester email",
    expectedRepairFile: "src/tickets.js",
  }),
  scenario({
    projectId: "support-desk",
    id: "unknown-plan-default-free",
    title: "unknown customer plans fall back to free support",
    complexity: "basic",
    tags: ["support", "accounts", "fallbacks"],
    sourcePath: "src/accounts.js",
    passingText: "  return CUSTOMER_PLANS[normalizedId] ?? CUSTOMER_PLANS.free;",
    failingText: "  return CUSTOMER_PLANS[normalizedId] ?? CUSTOMER_PLANS.enterprise;",
    commitMessage: "Reproduce failing unknown plan fallback pipeline",
    expectedFailure: "unknown customer plans fall back to free support",
    expectedRepairFile: "src/accounts.js",
  }),
  scenario({
    projectId: "support-desk",
    id: "vip-plan-priority-routing",
    title: "priority plans route tickets to the priority queue",
    complexity: "intermediate",
    tags: ["support", "routing", "plans"],
    sourcePath: "src/routing.js",
    passingText: '  if (customerPlan.prioritySupport) return "priority";',
    failingText: '  if (customerPlan.prioritySupport) return "support";',
    commitMessage: "Reproduce failing priority routing pipeline",
    expectedFailure: "priority support routes enterprise tickets",
    expectedRepairFile: "src/routing.js",
  }),
  scenario({
    projectId: "support-desk",
    id: "critical-ticket-incident-routing",
    title: "critical tickets route to incident response before plan routing",
    complexity: "intermediate",
    tags: ["support", "routing", "incidents"],
    sourcePath: "src/routing.js",
    passingText: '  if (ticket.severity === "critical") return "incident";',
    failingText: '  if (ticket.severity === "critical") return "priority";',
    commitMessage: "Reproduce failing incident routing pipeline",
    expectedFailure: "critical tickets route to incident response",
    expectedRepairFile: "src/routing.js",
  }),
  scenario({
    projectId: "support-desk",
    id: "weekend-sla-delay",
    title: "weekend ticket deadlines include weekend delay",
    complexity: "intermediate",
    tags: ["support", "sla", "time"],
    sourcePath: "src/sla.js",
    passingText: "  const dueHours = policy.responseHours + weekendDelayHours(openedAt);",
    failingText: "  const dueHours = policy.responseHours;",
    commitMessage: "Reproduce failing weekend SLA pipeline",
    expectedFailure: "weekend ticket deadlines include weekend delay",
    expectedRepairFile: "src/sla.js",
  }),
  scenario({
    projectId: "support-desk",
    id: "admin-can-close-cross-team",
    title: "admins can close tickets outside their team",
    complexity: "basic",
    tags: ["support", "permissions"],
    sourcePath: "src/permissions.js",
    passingText: '  return user.role === "admin" || user.team === ticket.team;',
    failingText: "  return user.team === ticket.team;",
    commitMessage: "Reproduce failing admin close permission pipeline",
    expectedFailure: "admins can close tickets outside their team",
    expectedRepairFile: "src/permissions.js",
  }),
  scenario({
    projectId: "support-desk",
    id: "notification-channel-dedupe",
    title: "notification keys dedupe channel case and whitespace",
    complexity: "basic",
    tags: ["support", "notifications", "dedupe"],
    sourcePath: "src/notifications.js",
    passingText: "  return String(channel).trim().toLowerCase();",
    failingText: "  return String(channel).trim();",
    commitMessage: "Reproduce failing notification dedupe pipeline",
    expectedFailure: "notification keys dedupe channel case and whitespace",
    expectedRepairFile: "src/notifications.js",
  }),
  scenario({
    projectId: "support-desk",
    id: "audit-redacts-internal-note",
    title: "audit events redact internal notes",
    complexity: "intermediate",
    tags: ["support", "audit", "privacy"],
    sourcePath: "src/audit.js",
    passingText: "    internalNote: undefined,",
    failingText: "    internalNote: event.internalNote,",
    commitMessage: "Reproduce failing audit redaction pipeline",
    expectedFailure: "audit events redact internal notes",
    expectedRepairFile: "src/audit.js",
  }),
  scenario({
    projectId: "support-desk",
    id: "reporting-resolution-rate",
    title: "reporting calculates resolution rate from resolved tickets",
    complexity: "intermediate",
    tags: ["support", "reporting", "analytics"],
    sourcePath: "src/reporting.js",
    passingText: '  const resolved = tickets.filter((ticket) => ticket.status === "resolved").length;',
    failingText: "  const resolved = tickets.length;",
    commitMessage: "Reproduce failing reporting resolution rate pipeline",
    expectedFailure: "reporting calculates resolution rate from resolved tickets",
    expectedRepairFile: "src/reporting.js",
  }),
  scenario({
    projectId: "support-desk",
    id: "ticket-tag-normalization",
    title: "ticket tags are normalized for routing",
    complexity: "basic",
    tags: ["support", "tickets", "routing", "input-normalization"],
    sourcePath: "src/tickets.js",
    passingText: "  const tags = (input.tags ?? []).map((tag) => String(tag).trim().toLowerCase()).filter(Boolean);",
    failingText: "  const tags = (input.tags ?? []).map((tag) => String(tag).trim()).filter(Boolean);",
    commitMessage: "Reproduce failing ticket tag normalization pipeline",
    expectedFailure: "ticket tags are normalized for routing",
    expectedRepairFile: "src/tickets.js",
  }),
  scenario({
    projectId: "support-desk",
    id: "support-triage-cascade",
    title: "support triage recovers email, routing, and SLA regressions together",
    complexity: "complex",
    tags: ["support", "tickets", "routing", "sla", "multi-file"],
    mutations: [
      {
        sourcePath: "src/tickets.js",
        passingText: "  const requesterEmail = String(input.requesterEmail).trim().toLowerCase();",
        failingText: "  const requesterEmail = String(input.requesterEmail).trim();",
      },
      {
        sourcePath: "src/routing.js",
        passingText: '  if (customerPlan.prioritySupport) return "priority";',
        failingText: '  if (customerPlan.prioritySupport) return "support";',
      },
      {
        sourcePath: "src/sla.js",
        passingText: "  const dueHours = policy.responseHours + weekendDelayHours(openedAt);",
        failingText: "  const dueHours = policy.responseHours;",
      },
    ],
    commitMessage: "Reproduce failing support triage cascade",
    expectedFailure: "support triage recovers email, routing, and SLA regressions",
    expectedRepairFiles: ["src/tickets.js", "src/routing.js", "src/sla.js"],
  }),
  scenario({
    projectId: "support-desk",
    id: "requester-profile-triage-cascade",
    title: "requester profile triage preserves plan inference, billing routing, and localized notifications",
    complexity: "complex",
    tags: ["support", "requesters", "routing", "notifications", "multi-file"],
    mutations: [
      {
        sourcePath: "src/workflow.js",
        passingText: `  const customerPlanId = input.customerPlanId ?? requesterProfile.customerPlanId ?? ticket.customerPlanId;
  const customerPlan = lookupCustomerPlan(customerPlanId);`,
        failingText: "  const customerPlan = lookupCustomerPlan(ticket.customerPlanId);",
      },
      {
        sourcePath: "src/routing.js",
        passingText: `  if (ticket.tags.includes("billing")) return "billing";
  if (customerPlan.prioritySupport) return "priority";`,
        failingText: `  if (customerPlan.prioritySupport) return "priority";
  if (ticket.tags.includes("billing")) return "billing";`,
      },
      {
        sourcePath: "src/notifications.js",
        passingText: '  const prefix = SUBJECT_PREFIX_BY_LOCALE[locale] ?? SUBJECT_PREFIX_BY_LOCALE["en-US"];',
        failingText: '  const prefix = SUBJECT_PREFIX_BY_LOCALE["en-US"];',
      },
    ],
    commitMessage: "Reproduce failing requester profile triage cascade",
    expectedFailure: "known requester profiles drive plan inference, billing routing, and localized notifications",
    expectedRepairFiles: ["src/workflow.js", "src/routing.js", "src/notifications.js"],
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
  return [
    ...scenarios.map((scenario) => `${scenario.templatePath}/.hootline.yaml`),
    ...scenarios.map((scenario) => `${scenario.templatePath}/package.json`),
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
