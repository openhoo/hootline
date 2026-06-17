import type {
  FailureContext,
  MergeChangeInput,
  NormalizedPipelineEvent,
  PublishInput,
  PublishResult,
} from "../types.ts";
import { redact } from "../redact.ts";
export {
  isRecord,
  readNumber,
  readString,
  requireArray,
  requireRecord,
  type UnknownRecord,
} from "../unknown.ts";

export const PROVIDER_REQUEST_TIMEOUT_MS = 30000;
export const PROVIDER_DOWNLOAD_TIMEOUT_MS = 120000;
export const MAX_LOG_BYTES = 256 * 1024;

export interface ProviderClient {
  getFailureContext(event: NormalizedPipelineEvent): Promise<FailureContext>;
  downloadArchive(event: NormalizedPipelineEvent, maxSnapshotBytes: number): Promise<Buffer>;
  publishFix(input: PublishInput): Promise<PublishResult>;
  postComment(event: NormalizedPipelineEvent, body: string): Promise<void>;
  rerunPipeline(event: NormalizedPipelineEvent): Promise<{ message: string }>;
  mergeChange(input: MergeChangeInput): Promise<PublishResult>;
}

export async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function assertResponseOk(response: Response, body: unknown, label: string): void {
  if (response.ok) return;
  throw new Error(`${label} failed with HTTP ${response.status}: ${formatErrorBody(body)}`);
}

export function buildFixBranchName(prefix: string, event: NormalizedPipelineEvent): string {
  return [
    ...prefix.split("/").map(sanitizeBranchComponent).filter(Boolean),
    sanitizeBranchComponent(event.ref),
    sanitizeBranchComponent(event.sha.slice(0, 12)),
  ].join("/");
}

function formatErrorBody(body: unknown): string {
  let text: string;
  if (typeof body === "string") {
    text = body;
  } else {
    try {
      text = JSON.stringify(body);
    } catch {
      text = String(body);
    }
  }
  return redact(text ?? "", 4000);
}

export async function readCappedText(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (body === null) return await response.text();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      const remaining = maxBytes - total;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function readBodyWithCap(response: Response, maxBytes: number): Promise<Buffer> {
  const body = response.body;
  if (body === null) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new Error(`Provider response body exceeds ${maxBytes} bytes.`);
    }
    return buffer;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`Provider response body exceeds ${maxBytes} bytes.`);
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}

function sanitizeBranchComponent(value: string): string {
  const sanitized = value
    .replaceAll("/", "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/@{/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .replace(/\.lock$/i, "");
  return sanitized.length > 0 ? sanitized : "ref";
}
