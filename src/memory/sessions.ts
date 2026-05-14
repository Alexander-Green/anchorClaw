import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildSessionEntry as buildSessionEntryFromSdk,
  listSessionFilesForAgent,
  sessionPathForFile,
} from "openclaw/plugin-sdk/memory-core-host-engine-qmd";

import type { MemorySearchHit } from "./search.js";
import { buildMemoryReadResult, type MemoryReadResult } from "./read-file-shared.js";
import type { MemoryLimits } from "./limits.js";

function normalizeAgentId(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return "main";
  }
  const normalized = trimmed.replaceAll(/[^a-z0-9._-]+/g, "-").replaceAll(/^-+|-+$/g, "");
  return normalized || "main";
}

function expandHome(input: string): string {
  return input.startsWith("~") ? path.join(os.homedir(), input.slice(1)) : input;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.stat(candidate);
    return true;
  } catch {
    return false;
  }
}

async function resolveStateDir(): Promise<string> {
  const override = process.env.OPENCLAW_STATE_DIR?.trim();
  if (override) {
    return path.resolve(expandHome(override));
  }
  const newDir = path.join(os.homedir(), ".openclaw");
  const legacyDir = path.join(os.homedir(), ".clawdbot");
  if (await pathExists(newDir)) {
    return newDir;
  }
  if (await pathExists(legacyDir)) {
    return legacyDir;
  }
  return newDir;
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
  const normalized = normalizeAgentId(agentId ?? "main");
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
      const expectedAgentId = normalizeAgentId(params.agentId ?? "main");
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
  return buildMemoryReadResult({
    content: entry.content,
    relPath: sessionPathForFile(absPath),
    from: params.fromLine,
    lines: params.lineCount,
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
