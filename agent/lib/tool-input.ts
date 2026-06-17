import type { UnknownRecord } from "./unknown.ts";

export const optionalAttemptKeySchema = {
  type: "object",
  properties: {
    attemptKey: { type: "string", minLength: 1, maxLength: 512 },
  },
  additionalProperties: false,
} as const;

export const summarySchema = {
  type: "object",
  properties: {
    attemptKey: { type: "string", minLength: 1, maxLength: 512 },
    summary: { type: "string", minLength: 1, maxLength: 4000 },
  },
  required: ["summary"],
  additionalProperties: false,
} as const;

export const commentSchema = {
  type: "object",
  properties: {
    attemptKey: { type: "string", minLength: 1, maxLength: 512 },
    body: { type: "string", minLength: 1, maxLength: 4000 },
  },
  required: ["body"],
  additionalProperties: false,
} as const;

export const rerunSchema = {
  type: "object",
  properties: {
    attemptKey: { type: "string", minLength: 1, maxLength: 512 },
    reason: { type: "string", minLength: 1, maxLength: 1000 },
  },
  required: ["reason"],
  additionalProperties: false,
} as const;

export const mergeSchema = {
  type: "object",
  properties: {
    attemptKey: { type: "string", minLength: 1, maxLength: 512 },
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
