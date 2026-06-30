import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_SCENARIO_ID = "shipping-threshold-basis";

export const SCENARIOS = [
  scenario({
    id: "shipping-threshold-basis",
    title: "free shipping uses pre-discount merchandise subtotal",
    complexity: "basic",
    tags: ["shipping", "discounts"],
    sourcePath: "src/shipping.js",
    passingText: "  const shippingBasisCents = merchandiseSubtotalCents;",
    failingText: "  const shippingBasisCents = discountedSubtotalCents;",
    commitMessage: "Reproduce failing shipping threshold pipeline",
    expectedFailure: "free shipping based on merchandise subtotal",
    expectedRepairFile: "src/shipping.js",
  }),
  scenario({
    id: "promotion-code-normalization",
    title: "promotion lookup normalizes customer-entered codes",
    complexity: "basic",
    tags: ["promotions", "input-normalization"],
    sourcePath: "src/promotions.js",
    passingText: "  const normalizedCode = String(promotionCode).trim().toUpperCase();",
    failingText: "  const normalizedCode = String(promotionCode).trim();",
    commitMessage: "Reproduce failing promotion normalization pipeline",
    expectedFailure: "normalizes promotion codes",
    expectedRepairFile: "src/promotions.js",
  }),
  scenario({
    id: "mixed-cart-shipping",
    title: "mixed physical and digital carts still need physical shipping",
    complexity: "basic",
    tags: ["shipping", "cart-classification"],
    sourcePath: "src/orders.js",
    passingText: "  const allDigital = lines.every((line) => line.weightOunces === 0);",
    failingText: "  const allDigital = lines.some((line) => line.weightOunces === 0);",
    commitMessage: "Reproduce failing mixed-cart shipping pipeline",
    expectedFailure: "mixed physical and digital carts",
    expectedRepairFile: "src/orders.js",
  }),
  scenario({
    id: "percentage-rounding",
    title: "percentage money math rounds to the nearest cent",
    complexity: "basic",
    tags: ["money", "rounding"],
    sourcePath: "src/money.js",
    passingText: "  return Math.round((cents * percent) / 100);",
    failingText: "  return Math.floor((cents * percent) / 100);",
    commitMessage: "Reproduce failing percentage rounding pipeline",
    expectedFailure: "rounds percentage calculations",
    expectedRepairFile: "src/money.js",
  }),
  scenario({
    id: "express-shipping-not-free",
    title: "express shipping is never made free by the standard threshold",
    complexity: "intermediate",
    tags: ["shipping", "service-level"],
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
    id: "digital-gift-card-tax-exemption",
    title: "digital gift cards stay non-taxable",
    complexity: "intermediate",
    tags: ["catalog", "tax"],
    sourcePath: "src/catalog.js",
    passingText: `  "digital-gift-card": Object.freeze({
    sku: "digital-gift-card",
    name: "Digital Gift Card",
    unitPriceCents: 2500,
    taxable: false,
    weightOunces: 0,
  }),`,
    failingText: `  "digital-gift-card": Object.freeze({
    sku: "digital-gift-card",
    name: "Digital Gift Card",
    unitPriceCents: 2500,
    taxable: true,
    weightOunces: 0,
  }),`,
    commitMessage: "Reproduce failing digital gift card tax pipeline",
    expectedFailure: "does not charge shipping for digital-only carts",
    expectedRepairFile: "src/catalog.js",
  }),
  scenario({
    id: "cart-line-quantity-subtotal",
    title: "cart line subtotals multiply unit price by quantity",
    complexity: "intermediate",
    tags: ["catalog", "totals"],
    sourcePath: "src/catalog.js",
    passingText: "  const lineSubtotalCents = product.unitPriceCents * item.quantity;",
    failingText: "  const lineSubtotalCents = product.unitPriceCents;",
    commitMessage: "Reproduce failing cart quantity subtotal pipeline",
    expectedFailure: "builds a readable receipt from the quoted order",
    expectedRepairFile: "src/catalog.js",
  }),
  scenario({
    id: "receipt-total-line",
    title: "receipt total line includes shipping and tax",
    complexity: "intermediate",
    tags: ["receipt", "totals"],
    sourcePath: "src/receipt.js",
    passingText: "    `Total ${formatCents(order.totals.totalCents)}`,",
    failingText: "    `Total ${formatCents(order.totals.discountedSubtotalCents)}`,",
    commitMessage: "Reproduce failing receipt total pipeline",
    expectedFailure: "builds a readable receipt from the quoted order",
    expectedRepairFile: "src/receipt.js",
  }),
  scenario({
    id: "tax-rate-state-lookup",
    title: "tax calculation uses the destination state's configured rate",
    complexity: "intermediate",
    tags: ["tax", "destination"],
    sourcePath: "src/tax.js",
    passingText: "  const taxRatePercent = TAX_RATES_BY_STATE[state];",
    failingText: "  const taxRatePercent = TAX_RATES_BY_STATE.OR;",
    commitMessage: "Reproduce failing destination tax lookup pipeline",
    expectedFailure: "rounds percentage calculations to the nearest cent",
    expectedRepairFile: "src/tax.js",
  }),
  scenario({
    id: "brewclub-minimum-threshold",
    title: "BREWCLUB15 keeps its documented eligibility threshold",
    complexity: "intermediate",
    tags: ["promotions", "configuration"],
    sourcePath: "src/promotions.js",
    passingText: `  BREWCLUB15: Object.freeze({
    code: "BREWCLUB15",
    percentOff: 15,
    minimumSubtotalCents: 7500,
  }),`,
    failingText: `  BREWCLUB15: Object.freeze({
    code: "BREWCLUB15",
    percentOff: 15,
    minimumSubtotalCents: 10000,
  }),`,
    commitMessage: "Reproduce failing BREWCLUB threshold pipeline",
    expectedFailure: "normalizes promotion codes before lookup",
    expectedRepairFile: "src/promotions.js",
  }),
  scenario({
    id: "checkout-money-shipping-tax-cascade",
    title: "checkout totals survive simultaneous money, shipping, and tax regressions",
    complexity: "complex",
    tags: ["money", "shipping", "tax", "multi-file"],
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
    id: "catalog-promotion-receipt-cascade",
    title: "cart quantities, promotion lookup, and receipt rendering recover together",
    complexity: "complex",
    tags: ["catalog", "promotions", "receipt", "multi-file"],
    mutations: [
      {
        sourcePath: "src/catalog.js",
        passingText: "  const lineSubtotalCents = product.unitPriceCents * item.quantity;",
        failingText: "  const lineSubtotalCents = product.unitPriceCents;",
      },
      {
        sourcePath: "src/promotions.js",
        passingText: "  const normalizedCode = String(promotionCode).trim().toUpperCase();",
        failingText: "  const normalizedCode = String(promotionCode).trim();",
      },
      {
        sourcePath: "src/receipt.js",
        passingText: "    `Total ${formatCents(order.totals.totalCents)}`,",
        failingText: "    `Total ${formatCents(order.totals.discountedSubtotalCents)}`,",
      },
    ],
    commitMessage: "Reproduce failing catalog promotion receipt cascade",
    expectedFailure: "multiple checkout and receipt regressions",
    expectedRepairFiles: ["src/catalog.js", "src/promotions.js", "src/receipt.js"],
  }),
  scenario({
    id: "fulfillment-method-cascade",
    title: "fulfillment rules distinguish digital carts, taxable catalog data, and express service",
    complexity: "complex",
    tags: ["shipping", "catalog", "tax", "multi-file"],
    mutations: [
      {
        sourcePath: "src/orders.js",
        passingText: "  const allDigital = lines.every((line) => line.weightOunces === 0);",
        failingText: "  const allDigital = lines.some((line) => line.weightOunces === 0);",
      },
      {
        sourcePath: "src/catalog.js",
        passingText: `  "digital-gift-card": Object.freeze({
    sku: "digital-gift-card",
    name: "Digital Gift Card",
    unitPriceCents: 2500,
    taxable: false,
    weightOunces: 0,
  }),`,
        failingText: `  "digital-gift-card": Object.freeze({
    sku: "digital-gift-card",
    name: "Digital Gift Card",
    unitPriceCents: 2500,
    taxable: true,
    weightOunces: 0,
  }),`,
      },
      {
        sourcePath: "src/shipping.js",
        passingText: `  const freeShippingApplied =
    service.method === "standard" && shippingBasisCents >= FREE_SHIPPING_THRESHOLD_CENTS;`,
        failingText: `  const freeShippingApplied =
    shippingBasisCents >= FREE_SHIPPING_THRESHOLD_CENTS;`,
      },
    ],
    commitMessage: "Reproduce failing fulfillment method cascade",
    expectedFailure: "mixed physical, digital, and express shipping regressions",
    expectedRepairFiles: ["src/orders.js", "src/catalog.js", "src/shipping.js"],
  }),
];

export function scenarioIds() {
  return SCENARIOS.map((scenario) => scenario.id);
}

export function resolveScenario(id = DEFAULT_SCENARIO_ID) {
  const scenario = SCENARIOS.find((entry) => entry.id === id);
  if (scenario === undefined) {
    throw new Error(`Unknown fixture scenario '${id}'. Available scenarios: ${scenarioIds().join(", ")}`);
  }
  return scenario;
}

export function resolveScenarios(selection) {
  if (selection === "all") return [...SCENARIOS];
  const ids = selection
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (ids.length === 0) throw new Error("At least one scenario id is required.");
  return ids.map((id) => resolveScenario(id));
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
    ".hootline.yaml",
    "src/catalog.js",
    "src/index.js",
    "src/money.js",
    "src/orders.js",
    "src/promotions.js",
    "src/receipt.js",
    "src/shipping.js",
    "src/tax.js",
    "test/order-pricing.test.js",
    ...scenarios.flatMap((scenario) => scenarioSourcePaths(scenario)),
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
    sources.set(sourcePath, source.replace(mutation.passingText, mutation.failingText));
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
