import type {
  FailureContext,
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

export interface ProviderClient {
  getFailureContext(event: NormalizedPipelineEvent): Promise<FailureContext>;
  downloadArchive(event: NormalizedPipelineEvent): Promise<Buffer>;
  publishFix(input: PublishInput): Promise<PublishResult>;
  postComment(event: NormalizedPipelineEvent, body: string): Promise<void>;
  rerunPipeline(event: NormalizedPipelineEvent): Promise<{ message: string }>;
  mergeChange(input: {
    event: NormalizedPipelineEvent;
    changeNumber: number;
    branch: string;
    deleteSourceBranch: boolean;
  }): Promise<PublishResult>;
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
