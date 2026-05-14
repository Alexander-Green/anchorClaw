import fs from "node:fs/promises";
import path from "node:path";
import {
  buildSessionEntry as buildSessionEntryFromSdk,
  listSessionFilesForAgent,
  sessionPathForFile,
} from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { resolveStateDir as resolveStateDirFromSdk } from "openclaw/plugin-sdk/state-paths";

import type { MemorySearchHit } from "./search.js";
import { type MemoryReadResult } from "./read-file-shared.js";
import type { MemoryLimits } from "./limits.js";

/**
 * Thin async wrapper for OpenClaw SDK resolver.
 * We keep it async to avoid touching existing call sites.
 */
async function resolveStateDir(): Promise<string> {
  return resolveStateDirFromSdk(process.env);
}

export async function listKnownAgentIds(): Promise<string[]> {
  const stateDir = await resolveStateDir();
  const agentsDir = path.join(stateDir, "agents");
  try {
    const dirents = await fs.readdir(agentsDir, { withFileTypes: true });
    return dirents
      .filter((dirent: { isDirectory(): boolean; name: string }) => dirent.isDirectory())
      .map((dirent: { name: string }) => dirent.name)
      .filter((name: string) => name.trim().length > 0)
      .sort((left: string, right: string) => left.localeCompare(right));
  } catch {
    return [];
  }
}

export async function resolveSessionsDirForAgent(agentId?: string): Promise<string> {
  const stateDir = await resolveStateDir();
  const normalized = normalizeAgentId(agentId);
  return path.join(stateDir, "agents", normalized, "sessions");
}

export async function isSessionFileForAgent(params: {
  sessionFile: string;
  agentId?: string;
}): Promise<boolean> {
  const candidate = params.sessionFile.trim();
  if (!candidate) {
    return false;
  }
  const normalizedLookup = candidate.replaceAll("\\", "/");
  if (normalizedLookup.startsWith("sessions/")) {
    const parts = normalizedLookup.split("/").filter(Boolean);
    if (parts.length === 3 && parts[0] === "sessions") {
      const lookupAgentId = normalizeAgentId(parts[1] ?? "");
      const expectedAgentId = normalizeAgentId(params.agentId);
      return lookupAgentId === expectedAgentId;
    }
  }
  const sessionsDir = path.resolve(await resolveSessionsDirForAgent(params.agentId));
  const absPath = path.resolve(candidate);
  const rel = path.relative(sessionsDir, absPath);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export async function isSessionFileForAnyKnownAgent(sessionFile: string): Promise<boolean> {
  const candidate = sessionFile.trim();
  if (!candidate) {
    return false;
  }
  const agentIds = await listKnownAgentIds();
  const normalizedCandidate = path.resolve(candidate);
  for (const agentId of agentIds) {
    const sessionsDir = path.resolve(await resolveSessionsDirForAgent(agentId));
    const rel = path.relative(sessionsDir, normalizedCandidate);
    if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      return true;
    }
  }
  return false;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  const rounded = Math.floor(value);
  return Math.min(max, Math.max(min, rounded));
}

function buildContinuationNotice(nextFrom: number | undefined): string {
  const base =
    typeof nextFrom === "number"
      ? `[More content available. Use from=${nextFrom} to continue.]`
      : "[More content available. Requested excerpt exceeded the default maxChars budget.]";
  return `\n\n${base}`;
}

function buildIndexedSessionReadResult(params: {
  lines: string[];
  lineMap: number[];
  relPath: string;
  from?: number;
  lineCount?: number;
  defaultLines: number;
  maxChars: number;
}): MemoryReadResult {
  const requestedFrom = clampInteger(params.from ?? 1, 1, Number.MAX_SAFE_INTEGER);
  const requestedLineCount = clampInteger(
    params.lineCount ?? params.defaultLines,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const requestedEndExclusive = requestedFrom + requestedLineCount;
  const maxChars = Math.max(1, Math.floor(params.maxChars));

  const grouped = new Map<number, string[]>();
  for (let idx = 0; idx < params.lines.length; idx += 1) {
    const sourceLine = params.lineMap[idx] ?? idx + 1;
    if (!Number.isFinite(sourceLine) || sourceLine <= 0) {
      continue;
    }
    const bucket = grouped.get(sourceLine) ?? [];
    bucket.push(params.lines[idx] ?? "");
    grouped.set(sourceLine, bucket);
  }
  const sourceLines = Array.from(grouped.keys()).sort((left, right) => left - right);
  const selectedSourceLines = sourceLines.filter(
    (lineNo) => lineNo >= requestedFrom && lineNo < requestedEndExclusive,
  );
  if (selectedSourceLines.length === 0) {
    return {
      text: "",
      path: params.relPath,
      from: requestedFrom,
      lines: 0,
    };
  }
  const selectedRenderedLines = selectedSourceLines.flatMap((lineNo) => grouped.get(lineNo) ?? []);
  const moreSourceLinesRemain = sourceLines.some((lineNo) => lineNo >= requestedEndExclusive);

  let includedRenderedCount = selectedRenderedLines.length;
  let text = selectedRenderedLines.join("\n");
  while (includedRenderedCount > 1 && text.length > maxChars) {
    includedRenderedCount -= 1;
    text = selectedRenderedLines.slice(0, includedRenderedCount).join("\n");
  }

  let hardTruncatedSingleLine = false;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    includedRenderedCount = 1;
    hardTruncatedSingleLine = true;
  }

  let includedSourceLines = selectedSourceLines.length;
  if (includedRenderedCount < selectedRenderedLines.length) {
    let renderedSeen = 0;
    includedSourceLines = 0;
    for (const lineNo of selectedSourceLines) {
      renderedSeen += (grouped.get(lineNo) ?? []).length;
      if (renderedSeen > includedRenderedCount) {
        break;
      }
      includedSourceLines += 1;
    }
  }

  const truncated =
    hardTruncatedSingleLine || includedRenderedCount < selectedRenderedLines.length || moreSourceLinesRemain;
  const nextLineAfterRange = sourceLines.find((lineNo) => lineNo >= requestedEndExclusive);
  const nextLineWithinRange = selectedSourceLines[includedSourceLines];
  const nextFrom =
    !hardTruncatedSingleLine && includedSourceLines > 0
      ? nextLineWithinRange ?? nextLineAfterRange
      : undefined;

  return {
    text: truncated && text ? `${text}${buildContinuationNotice(nextFrom)}` : text,
    path: params.relPath,
    from: selectedSourceLines[0] ?? requestedFrom,
    lines: includedSourceLines,
    ...(truncated ? { truncated: true } : {}),
    ...(typeof nextFrom === "number" ? { nextFrom } : {}),
  };
}

function parseSessionLookup(lookup: string): { agentId?: string; fileName: string } | null {
  const trimmed = lookup.trim();
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length < 2 || parts[0] !== "sessions") {
    return null;
  }
  if (parts.length === 2) {
    return { fileName: parts[1]! };
  }
  if (parts.length === 3) {
    return { agentId: parts[1]!, fileName: parts[2]! };
  }
  return null;
}

function isSafeSessionFileName(fileName: string): boolean {
  const trimmed = fileName.trim();
  return (
    trimmed.length > 0 &&
    trimmed !== "." &&
    trimmed !== ".." &&
    !trimmed.includes("/") &&
    !trimmed.includes("\\")
  );
}

export async function memoryGetSessionFile(params: {
  lookup: string;
  currentAgentId?: string;
  fromLine?: number;
  lineCount?: number;
  defaultLines: number;
  maxChars: number;
  limits: Pick<MemoryLimits, "sessionsMaxFileBytes" | "sessionsWrapChars">;
}): Promise<MemoryReadResult | null> {
  const parsed = parseSessionLookup(params.lookup);
  if (!parsed) {
    return null;
  }
  if (!isSafeSessionFileName(parsed.fileName)) {
    return null;
  }
  const effectiveAgentId = parsed.agentId ?? params.currentAgentId ?? "main";
  const sessionsDir = await resolveSessionsDirForAgent(effectiveAgentId);
  const absPath = path.join(sessionsDir, parsed.fileName);
  const entry = await buildSessionEntryFromSdk(absPath);
  if (!entry) {
    return null;
  }
  const renderedLines = entry.content.split("\n");
  return buildIndexedSessionReadResult({
    lines: renderedLines,
    lineMap: entry.lineMap,
    relPath: sessionPathForFile(absPath),
    from: params.fromLine,
    lineCount: params.lineCount,
    defaultLines: params.defaultLines,
    maxChars: params.maxChars,
  });
}

export async function memorySearchSessions(params: {
  query: string;
  maxResults: number;
  agentId?: string;
  limits: Pick<MemoryLimits, "sessionsMaxFileBytes" | "sessionsWrapChars">;
}): Promise<MemorySearchHit[]> {
  const q = params.query.trim();
  if (!q) {
    return [];
  }
  const limit = clampInteger(params.maxResults, 1, params.maxResults);
  const agentId = params.agentId?.trim() ? params.agentId : "main";
  const sessionFiles = await listSessionFilesForAgent(agentId);

  const entries: Array<{ absPath: string; mtimeMs: number; content: string; lineMap: number[] }> = [];
  for (const absPath of sessionFiles) {
    const built = await buildSessionEntryFromSdk(absPath);
    if (!built) {
      continue;
    }
    entries.push({
      absPath,
      mtimeMs: built.mtimeMs,
      content: built.content,
      lineMap: built.lineMap,
    });
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const lowerNeedle = q.toLowerCase();
  const hits: MemorySearchHit[] = [];

  for (const entry of entries) {
    if (hits.length >= limit) {
      break;
    }

    const lines = entry.content.split("\n");
    for (let contentIndex = 0; contentIndex < lines.length; contentIndex += 1) {
      const line = lines[contentIndex] ?? "";
      if (!line) {
        continue;
      }
      if (!line.toLowerCase().includes(lowerNeedle)) {
        continue;
      }
      const snippet = line.length > 240 ? `${line.slice(0, 240)}…` : line;
      const startLine = entry.lineMap[contentIndex] ?? contentIndex + 1;
      hits.push({
        corpus: "sessions",
        path: sessionPathForFile(entry.absPath),
        kind: "session",
        score: 1,
        snippet,
        startLine,
        endLine: startLine,
        updatedAt: new Date(entry.mtimeMs).toISOString(),
      });
      break;
    }
  }

  return hits.slice(0, limit);
}
