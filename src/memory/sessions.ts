import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function normalizeSessionText(value: string): string {
  return value.replace(/\s*\n+\s*/g, " ").replace(/\s+/g, " ").trim();
}

function collectRawSessionText(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as { type?: unknown; text?: unknown };
    if (record.type === "text" && typeof record.text === "string") {
      parts.push(record.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

function splitLongSessionLine(text: string, maxChars: number): string[] {
  const normalized = text.trim();
  if (!normalized) {
    return [];
  }
  if (normalized.length <= maxChars) {
    return [normalized];
  }

  const segments: string[] = [];
  let cursor = 0;
  while (cursor < normalized.length) {
    const remaining = normalized.length - cursor;
    if (remaining <= maxChars) {
      segments.push(normalized.slice(cursor).trim());
      break;
    }

    const limit = cursor + maxChars;
    let splitAt = limit;
    for (let index = limit; index > cursor; index -= 1) {
      if (normalized[index] === " ") {
        splitAt = index;
        break;
      }
    }
    if (
      splitAt < normalized.length &&
      splitAt > cursor &&
      isHighSurrogate(normalized.charCodeAt(splitAt - 1)) &&
      isLowSurrogate(normalized.charCodeAt(splitAt))
    ) {
      splitAt -= 1;
    }
    segments.push(normalized.slice(cursor, splitAt).trim());
    cursor = splitAt;
    while (cursor < normalized.length && normalized[cursor] === " ") {
      cursor += 1;
    }
  }

  return segments.filter(Boolean);
}

function renderSessionExportLines(params: { label: string; text: string; maxChars: number }): string[] {
  return splitLongSessionLine(params.text, params.maxChars).map((segment) => `${params.label}: ${segment}`);
}

function sessionPathForFile(absPath: string): string {
  const normalized = path.normalize(path.resolve(absPath));
  const parts = normalized.split(path.sep).filter(Boolean);
  const sessionsIndex = parts.lastIndexOf("sessions");
  if (sessionsIndex >= 2 && parts[sessionsIndex - 2] === "agents") {
    const agentId = parts[sessionsIndex - 1];
    const fileName = parts[sessionsIndex + 1];
    if (agentId && fileName && sessionsIndex + 1 === parts.length - 1) {
      return `sessions/${agentId}/${fileName}`;
    }
  }
  return `sessions/${path.basename(absPath)}`;
}

async function buildSessionEntry(params: {
  absPath: string;
  limits: Pick<MemoryLimits, "sessionsMaxFileBytes" | "sessionsWrapChars">;
}): Promise<{ content: string; lineMap: number[] } | null> {
  try {
    const stat = await fs.stat(params.absPath);
    if (stat.size > params.limits.sessionsMaxFileBytes) {
      return null;
    }
    const raw = await fs.readFile(params.absPath, "utf8");
    const jsonlLines = raw.split("\n");
    const outLines: string[] = [];
    const lineMap: number[] = [];

    for (let index = 0; index < jsonlLines.length; index += 1) {
      const line = jsonlLines[index]?.trim();
      if (!line) {
        continue;
      }
      let record: any;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record?.type !== "message" || !record.message) {
        continue;
      }
      const role = record.message.role;
      if (role !== "user" && role !== "assistant") {
        continue;
      }
      const rawText = collectRawSessionText(record.message.content);
      if (!rawText) {
        continue;
      }
      const normalizedText = normalizeSessionText(rawText);
      if (!normalizedText) {
        continue;
      }
      const label = role === "user" ? "User" : "Assistant";
      const rendered = renderSessionExportLines({
        label,
        text: normalizedText,
        maxChars: params.limits.sessionsWrapChars,
      });
      for (const renderedLine of rendered) {
        outLines.push(renderedLine);
        lineMap.push(index + 1); // 1-based JSONL line number
      }
    }

    return { content: outLines.join("\n"), lineMap };
  } catch {
    return null;
  }
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
  const entry = await buildSessionEntry({ absPath, limits: params.limits });
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
  const sessionsDir = await resolveSessionsDirForAgent(params.agentId);

  let entries: Array<{ name: string; absPath: string; mtimeMs: number }> = [];
  try {
    const dirents = await fs.readdir(sessionsDir, { withFileTypes: true });
    const candidates = dirents
      .filter((dirent: { isFile(): boolean; name: string }) => dirent.isFile())
      .map((dirent: { name: string }) => dirent.name)
      // include live transcripts and usage-counted archives; skip other artifacts for MVP.
      .filter((name: string) => name.includes(".jsonl"));
    const stats = await Promise.all(
      candidates.map(async (name: string) => {
        const absPath = path.join(sessionsDir, name);
        const stat = (await fs.stat(absPath)) as { mtimeMs: number };
        return { name, absPath, mtimeMs: stat.mtimeMs };
      }),
    );
    entries = stats.sort((a: { mtimeMs: number }, b: { mtimeMs: number }) => b.mtimeMs - a.mtimeMs);
  } catch {
    return [];
  }

  const lowerNeedle = q.toLowerCase();
  const hits: MemorySearchHit[] = [];

  for (const entry of entries) {
    if (hits.length >= limit) {
      break;
    }

    const built = await buildSessionEntry({ absPath: entry.absPath, limits: params.limits });
    if (!built) {
      continue;
    }
    const lines = built.content.split("\n");
    for (let contentIndex = 0; contentIndex < lines.length; contentIndex += 1) {
      const line = lines[contentIndex] ?? "";
      if (!line) {
        continue;
      }
      if (!line.toLowerCase().includes(lowerNeedle)) {
        continue;
      }
      const snippet = line.length > 240 ? `${line.slice(0, 240)}…` : line;
      const startLine = contentIndex + 1;
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
