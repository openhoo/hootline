import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_SCENARIO_ID = "shipping-threshold-basis";

export const SCENARIOS = [
  {
    id: "shipping-threshold-basis",
    title: "free shipping uses pre-discount merchandise subtotal",
    sourcePath: "src/shipping.js",
    passingText: "  const shippingBasisCents = merchandiseSubtotalCents;",
    failingText: "  const shippingBasisCents = discountedSubtotalCents;",
    commitMessage: "Reproduce failing shipping threshold pipeline",
    expectedFailure: "free shipping based on merchandise subtotal",
    expectedRepairFile: "src/shipping.js",
  },
  {
    id: "promotion-code-normalization",
    title: "promotion lookup normalizes customer-entered codes",
    sourcePath: "src/promotions.js",
    passingText: "  const normalizedCode = String(promotionCode).trim().toUpperCase();",
    failingText: "  const normalizedCode = String(promotionCode).trim();",
    commitMessage: "Reproduce failing promotion normalization pipeline",
    expectedFailure: "normalizes promotion codes",
    expectedRepairFile: "src/promotions.js",
  },
  {
    id: "mixed-cart-shipping",
    title: "mixed physical and digital carts still need physical shipping",
    sourcePath: "src/orders.js",
    passingText: "  const allDigital = lines.every((line) => line.weightOunces === 0);",
    failingText: "  const allDigital = lines.some((line) => line.weightOunces === 0);",
    commitMessage: "Reproduce failing mixed-cart shipping pipeline",
    expectedFailure: "mixed physical and digital carts",
    expectedRepairFile: "src/orders.js",
  },
  {
    id: "percentage-rounding",
    title: "percentage money math rounds to the nearest cent",
    sourcePath: "src/money.js",
    passingText: "  return Math.round((cents * percent) / 100);",
    failingText: "  return Math.floor((cents * percent) / 100);",
    commitMessage: "Reproduce failing percentage rounding pipeline",
    expectedFailure: "rounds percentage calculations",
    expectedRepairFile: "src/money.js",
  },
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
    ...scenarios.map((scenario) => scenario.sourcePath),
  ].filter((file, index, files) => files.indexOf(file) === index);
}

export function assertScenarioBaseline(fixturePath, scenario) {
  const sourcePath = join(fixturePath, scenario.sourcePath);
  if (!existsSync(sourcePath)) {
    throw new Error(`Baseline is missing scenario source file: ${scenario.sourcePath}`);
  }
  const source = readFileSync(sourcePath, "utf8");
  assertExactOccurrence(source, scenario.passingText, scenario.sourcePath, "passing text");
  if (source.includes(scenario.failingText)) {
    throw new Error(`Baseline ${scenario.sourcePath} already contains failing text for ${scenario.id}.`);
  }
}

export function applyScenarioMutation(fixturePath, scenario) {
  const sourcePath = join(fixturePath, scenario.sourcePath);
  const source = readFileSync(sourcePath, "utf8");
  assertExactOccurrence(source, scenario.passingText, scenario.sourcePath, "passing text");
  writeFileSync(sourcePath, source.replace(scenario.passingText, scenario.failingText));
}

function assertExactOccurrence(source, needle, path, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) {
    throw new Error(`${path} must contain ${label} exactly once; found ${count}.`);
  }
}
