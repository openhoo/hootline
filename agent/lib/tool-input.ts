import type { UnknownRecord } from "./unknown.ts";

const ATTEMPT_KEY_MAX = 512;
const SUMMARY_MAX = 4000;
const COMMENT_BODY_MAX = 4000;
const REASON_MAX = 1000;

const attemptKeyProp = {
  attemptKey: { type: "string", minLength: 1, maxLength: ATTEMPT_KEY_MAX },
} as const;

export const optionalAttemptKeySchema = {
  type: "object",
  properties: {
    ...attemptKeyProp,
  },
  additionalProperties: false,
} as const;

export const summarySchema = {
  type: "object",
  properties: {
    ...attemptKeyProp,
    summary: { type: "string", minLength: 1, maxLength: SUMMARY_MAX },
  },
  required: ["summary"],
  additionalProperties: false,
} as const;

export const commentSchema = {
  type: "object",
  properties: {
    ...attemptKeyProp,
    body: { type: "string", minLength: 1, maxLength: COMMENT_BODY_MAX },
  },
  required: ["body"],
  additionalProperties: false,
} as const;

export const rerunSchema = {
  type: "object",
  properties: {
    ...attemptKeyProp,
    reason: { type: "string", minLength: 1, maxLength: REASON_MAX },
  },
  required: ["reason"],
  additionalProperties: false,
} as const;

export const mergeSchema = {
  type: "object",
  properties: {
    ...attemptKeyProp,
    confirmedSuccessfulPipeline: { type: "boolean", default: false },
  },
  additionalProperties: false,
} as const;

export function readOptionalString(input: UnknownRecord, key: string): string | undefined {
  const value = input[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function readRequiredString(input: UnknownRecord, key: string): string {
  const value = readOptionalString(input, key);
  if (value === undefined) throw new Error(`Missing required string input: ${key}`);
  return value;
}

export function readBoolean(input: UnknownRecord, key: string, defaultValue: boolean): boolean {
  const value = input[key];
  return typeof value === "boolean" ? value : defaultValue;
}
