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

export async function extractMaintenanceCandidates(params: {
  agentId: string;
  sourcePath: string;
  fileHash: string;
  transcript: string;
  maxCandidates: number;
  timeoutMs?: number;
}): Promise<ExtractorResult> {
  void params;
  throw new Error(
    "maintenance extractor is unavailable in this release build; use branch old/extractor for the archived experimental implementation",
  );
}
