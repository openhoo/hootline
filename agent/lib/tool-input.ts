import { isRecord } from "./unknown.ts";
import type { UnknownRecord } from "./unknown.ts";

const SUMMARY_MAX = 4000;
const COMMENT_BODY_MAX = 4000;
const REASON_MAX = 1000;
const INPUT_ENVELOPE_KEYS = new Set(["input", "args", "arguments", "parameters", "payload", "data"]);

type JsonValue = string | number | boolean | null | JsonValue[] | { readonly [key: string]: JsonValue };
type JsonObject = { readonly [key: string]: JsonValue };
type JsonSchemaProperties = Record<string, JsonObject>;

export interface AliasedValueCandidate<T> {
  key: string;
  value: T;
}

export const optionalAttemptKeySchema = {
  type: "object",
  properties: {
    attemptKey: { type: "string" },
    attempt_key: { type: "string" },
  },
  additionalProperties: true,
} as const;

export const summarySchema = {
  type: "object",
  properties: {
    summary: { type: "string", minLength: 1, maxLength: SUMMARY_MAX },
    message: { type: "string", minLength: 1, maxLength: SUMMARY_MAX },
    body: { type: "string", minLength: 1, maxLength: SUMMARY_MAX },
  },
  additionalProperties: true,
} as const;

export const commentSchema = {
  type: "object",
  properties: {
    body: { type: "string", minLength: 1, maxLength: COMMENT_BODY_MAX },
    message: { type: "string", minLength: 1, maxLength: COMMENT_BODY_MAX },
    comment: { type: "string", minLength: 1, maxLength: COMMENT_BODY_MAX },
    summary: { type: "string", minLength: 1, maxLength: COMMENT_BODY_MAX },
  },
  additionalProperties: true,
} as const;

export const rerunSchema = {
  type: "object",
  properties: {
    reason: { type: "string", minLength: 1, maxLength: REASON_MAX },
    message: { type: "string", minLength: 1, maxLength: REASON_MAX },
    summary: { type: "string", minLength: 1, maxLength: REASON_MAX },
  },
  additionalProperties: true,
} as const;

export const mergeSchema = {
  type: "object",
  properties: {
    confirmedSuccessfulPipeline: { type: "boolean", default: false },
    confirmed_successful_pipeline: { type: "boolean" },
    confirmed: { type: "boolean" },
  },
  additionalProperties: true,
} as const;

export function looseObjectSchema(properties: JsonSchemaProperties = {}) {
  return {
    type: "object",
    properties,
    additionalProperties: true,
  } as const;
}

export function normalizeToolInput(input: unknown): UnknownRecord {
  let current = parseJsonObjectString(input) ?? input;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!isRecord(current)) {
      throw new Error("Tool input must be an object.");
    }
    const entries = Object.entries(current).filter(([, value]) => value !== undefined);
    if (entries.length !== 1) return current;
    const [key, value] = entries[0] ?? [];
    if (typeof key !== "string" || !INPUT_ENVELOPE_KEYS.has(key)) return current;
    const unwrapped = parseJsonObjectString(value) ?? value;
    if (!isRecord(unwrapped)) return current;
    current = unwrapped;
  }
  if (!isRecord(current)) {
    throw new Error("Tool input must be an object.");
  }
  return current;
}

export function readOptionalString(input: UnknownRecord, key: string): string | undefined {
  const value = input[key];
  return normalizeOptionalString(value);
}

export function readRequiredString(input: UnknownRecord, key: string): string {
  const value = readOptionalString(input, key);
  if (value === undefined) throw new Error(`Missing required string input: ${key}`);
  return value;
}

export function readBoolean(input: UnknownRecord, key: string, defaultValue: boolean): boolean {
  const value = input[key];
  return normalizeOptionalBoolean(value) ?? defaultValue;
}

export function readOptionalAliasedString(
  input: UnknownRecord,
  canonicalKey: string,
  aliases: readonly string[] = [],
): string | undefined {
  return readAliasedValue(input, canonicalKey, aliases, normalizeOptionalString);
}

export function readRequiredAliasedString(
  input: UnknownRecord,
  canonicalKey: string,
  aliases: readonly string[] = [],
): string {
  const value = readOptionalAliasedString(input, canonicalKey, aliases);
  if (value === undefined) {
    const accepted = [canonicalKey, ...aliases].join(", ");
    throw new Error(`Missing required string input: ${canonicalKey}. Accepted keys: ${accepted}.`);
  }
  return value;
}

export function readRequiredAliasedText(
  input: UnknownRecord,
  canonicalKey: string,
  aliases: readonly string[] = [],
  options: { allowEmpty?: boolean } = {},
): string {
  const value = readAliasedValue(input, canonicalKey, aliases, (candidate) =>
    normalizeOptionalText(candidate, options.allowEmpty === true),
  );
  if (value === undefined) {
    const accepted = [canonicalKey, ...aliases].join(", ");
    throw new Error(`Missing required text input: ${canonicalKey}. Accepted keys: ${accepted}.`);
  }
  return value;
}

export function readOptionalAliasedText(
  input: UnknownRecord,
  canonicalKey: string,
  aliases: readonly string[] = [],
  options: { allowEmpty?: boolean } = {},
): string | undefined {
  return readAliasedValue(input, canonicalKey, aliases, (candidate) =>
    normalizeOptionalText(candidate, options.allowEmpty === true),
  );
}

export function readAliasedTextCandidates(
  input: UnknownRecord,
  canonicalKey: string,
  aliases: readonly string[] = [],
  options: { allowEmpty?: boolean } = {},
): Array<AliasedValueCandidate<string>> {
  return readAliasedCandidates(input, canonicalKey, aliases, (candidate) =>
    normalizeOptionalText(candidate, options.allowEmpty === true),
  );
}

export function readAliasedBoolean(
  input: UnknownRecord,
  canonicalKey: string,
  aliases: readonly string[] = [],
  defaultValue = false,
): boolean {
  return readAliasedValue(input, canonicalKey, aliases, normalizeOptionalBoolean) ?? defaultValue;
}

export function readRequiredAliasedInteger(
  input: UnknownRecord,
  canonicalKey: string,
  aliases: readonly string[] = [],
): number {
  const value = readAliasedValue(input, canonicalKey, aliases, normalizeOptionalInteger);
  if (value === undefined) {
    const accepted = [canonicalKey, ...aliases].join(", ");
    throw new Error(`Missing required integer input: ${canonicalKey}. Accepted keys: ${accepted}.`);
  }
  return value;
}

function readAliasedValue<T>(
  input: UnknownRecord,
  canonicalKey: string,
  aliases: readonly string[],
  normalize: (value: unknown) => T | undefined,
): T | undefined {
  let selected: T | undefined;
  let selectedKey: string | undefined;
  for (const key of [canonicalKey, ...aliases]) {
    if (!(key in input)) continue;
    const value = normalize(input[key]);
    if (value === undefined) continue;
    if (selected !== undefined && value !== selected) {
      throw new Error(
        `Conflicting values for input ${canonicalKey}: both ${selectedKey ?? canonicalKey} and ${key} were provided.`,
      );
    }
    selected = value;
    selectedKey = key;
  }
  return selected;
}

function readAliasedCandidates<T>(
  input: UnknownRecord,
  canonicalKey: string,
  aliases: readonly string[],
  normalize: (value: unknown) => T | undefined,
): Array<AliasedValueCandidate<T>> {
  const candidates: Array<AliasedValueCandidate<T>> = [];
  for (const key of [canonicalKey, ...aliases]) {
    if (!(key in input)) continue;
    const value = normalize(input[key]);
    if (value === undefined) continue;
    candidates.push({ key, value });
  }
  return candidates;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function normalizeOptionalText(value: unknown, allowEmpty: boolean): string | undefined {
  if (typeof value === "string") {
    if (allowEmpty || value.length > 0) return value;
    return undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function normalizeOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y"].includes(normalized)) return true;
    if (["false", "0", "no", "n"].includes(normalized)) return false;
  }
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  return undefined;
}

function normalizeOptionalInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^-?\d+$/u.test(trimmed)) return Number.parseInt(trimmed, 10);
  }
  return undefined;
}

function parseJsonObjectString(value: unknown): UnknownRecord | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
