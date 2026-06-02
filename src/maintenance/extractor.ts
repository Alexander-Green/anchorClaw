import { execFile } from "node:child_process";

export type ExtractorCandidate = {
  content: string;
  type: "fact" | "note";
  canonicalKey?: string;
  confidence?: number;
};

export type ExtractorResult = {
  summary: string;
  candidates: ExtractorCandidate[];
};

export {
  MAINTENANCE_INTERNAL_MARKER,
  MAINTENANCE_SESSION_ID_PREFIX,
} from "./constants.js";

import {
  MAINTENANCE_INTERNAL_MARKER,
  MAINTENANCE_SESSION_ID_PREFIX,
} from "./constants.js";

const DEFAULT_EXTRACTOR_TIMEOUT_MS = 60_000;

function execFileAsync(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 10 * 1024 * 1024, timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        const message = stderr?.trim() || error.message;
        reject(new Error(`extractor invocation failed (${message})`));
        return;
      }
      resolve(stdout);
    });
  });
}

function extractJsonFragment(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/u);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const trimmed = raw.trim();
  const firstObject = trimmed.indexOf("{");
  const lastObject = trimmed.lastIndexOf("}");
  if (firstObject >= 0 && lastObject > firstObject) {
    return trimmed.slice(firstObject, lastObject + 1);
  }
  return trimmed;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseCandidate(value: unknown): ExtractorCandidate {
  const row = asRecord(value);
  if (!row) {
    throw new Error("extractor candidate must be an object");
  }

  const content = typeof row.content === "string" ? row.content.trim() : "";
  if (!content) {
    throw new Error("extractor candidate.content must be a non-empty string");
  }
  if (row.type !== "fact" && row.type !== "note") {
    throw new Error("extractor candidate.type must be 'fact' or 'note'");
  }

  const canonicalKey =
    typeof row.canonicalKey === "string" && row.canonicalKey.trim()
      ? row.canonicalKey.trim()
      : undefined;
  if (row.canonicalKey !== undefined && !canonicalKey) {
    throw new Error("extractor candidate.canonicalKey must be a non-empty string when provided");
  }

  const confidence =
    typeof row.confidence === "number" && Number.isFinite(row.confidence)
      ? Math.min(100, Math.max(0, Math.floor(row.confidence)))
      : undefined;
  if (row.confidence !== undefined && confidence === undefined) {
    throw new Error("extractor candidate.confidence must be a finite number when provided");
  }

  return {
    content,
    type: row.type,
    ...(canonicalKey ? { canonicalKey } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
  };
}

function parseExtractorResult(raw: string): ExtractorResult {
  const parsedUnknown = JSON.parse(extractJsonFragment(raw)) as unknown;
  const parsed = asRecord(parsedUnknown);
  if (!parsed) {
    throw new Error("extractor output must be a JSON object");
  }
  if (typeof parsed.summary !== "string") {
    throw new Error("extractor output.summary must be a string");
  }
  if (!Array.isArray(parsed.candidates)) {
    throw new Error("extractor output.candidates must be an array");
  }
  return {
    summary: parsed.summary,
    candidates: parsed.candidates.map((item) => parseCandidate(item)),
  };
}

function buildPrompt(params: {
  sourcePath: string;
  fileHash: string;
  transcript: string;
  maxCandidates: number;
}): string {
  return [
    MAINTENANCE_INTERNAL_MARKER,
    "You are a durable-memory extractor for AnchorClaw daily memory.",
    "Read the transcript and return ONLY durable long-term memory candidates.",
    "Prefer stable facts, preferences, project rules, standing decisions, and lasting TODO context.",
    "Ignore transient chatter, already-completed one-off work, and routine operational noise.",
    "If the transcript already shows a successful durable memory write for a fact, do not return it again.",
    "Output strict JSON only with no markdown and no commentary.",
    `Return at most ${params.maxCandidates} candidates.`,
    "Schema:",
    '{"summary":"string","candidates":[{"content":"string","type":"fact|note","canonicalKey":"string(optional)","confidence":0}]}',
    `Source path: ${params.sourcePath}`,
    `Transcript hash: ${params.fileHash}`,
    "",
    "Transcript:",
    params.transcript,
  ].join("\n");
}

export async function extractMaintenanceCandidates(params: {
  agentId: string;
  sourcePath: string;
  fileHash: string;
  transcript: string;
  maxCandidates: number;
  timeoutMs?: number;
}): Promise<ExtractorResult> {
  const output = await execFileAsync(
    "openclaw",
    [
      "agent",
      "--agent",
      params.agentId,
      "--session-id",
      `${MAINTENANCE_SESSION_ID_PREFIX}${params.agentId}`,
      "--message",
      buildPrompt(params),
      "--json",
    ],
    params.timeoutMs ?? DEFAULT_EXTRACTOR_TIMEOUT_MS,
  );

  const outer = JSON.parse(output) as unknown;
  const outerRecord = asRecord(outer);
  if (outerRecord?.status === "ok") {
    const result = asRecord(outerRecord.result);
    const payloads = Array.isArray(result?.payloads) ? result.payloads : [];
    const firstPayload = asRecord(payloads[0]);
    const text = typeof firstPayload?.text === "string" ? firstPayload.text : "";
    return parseExtractorResult(text);
  }

  return parseExtractorResult(output);
}
