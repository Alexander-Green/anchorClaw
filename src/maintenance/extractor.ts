import type { OpenClawPluginApi } from "../api.js";

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

function resolveRuntimeLlm(api: OpenClawPluginApi): {
  complete: (params: Record<string, unknown>) => Promise<{ text: string }>;
} {
  const runtimeLlm = (api as any)?.runtime?.llm;
  if (typeof runtimeLlm?.complete !== "function") {
    throw new Error(
      "extractor runtime requires api.runtime.llm.complete (OpenClaw >= 2026.5.12)",
    );
  }
  return runtimeLlm;
}

export async function extractMaintenanceCandidates(params: {
  api: OpenClawPluginApi;
  sourcePath: string;
  fileHash: string;
  transcript: string;
  maxCandidates: number;
}): Promise<ExtractorResult> {
  try {
    const llm = resolveRuntimeLlm(params.api);
    const result = await llm.complete({
      messages: [
        {
          role: "user",
          content: buildPrompt(params),
        },
      ],
      purpose: "anchorclaw.maintenance.extractor",
      maxTokens: 1200,
      temperature: 0,
    });
    return parseExtractorResult(result.text);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("api.runtime.llm.complete")
    ) {
      throw error;
    }
    throw new Error(
      `extractor completion failed (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}
