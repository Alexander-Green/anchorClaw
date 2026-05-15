import {
  DEFAULT_SESSION_DELTA_BYTES,
  DEFAULT_SESSION_DELTA_MESSAGES,
  type AnchorClawConfig,
} from "../config.js";
import {
  isSessionArchiveArtifactName,
  isUsageCountedSessionTranscriptFileName,
} from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
import fs, { type FileHandle } from "node:fs/promises";
import type { SessionDeltaThresholds } from "./types.js";

const SESSION_DELTA_READ_CHUNK_BYTES = 64 * 1024;

export function isSessionArchiveArtifactPath(sessionFile: string): boolean {
  const fileName = sessionFile.replaceAll("\\", "/").split("/").pop() ?? "";
  return (
    isSessionArchiveArtifactName(fileName) &&
    isUsageCountedSessionTranscriptFileName(fileName)
  );
}

export function countNewlinesFromChunk(chunk: string): number {
  let count = 0;
  for (let i = 0; i < chunk.length; i += 1) {
    if (chunk.charCodeAt(i) === 10) {
      count += 1;
    }
  }
  return count;
}

export async function countNewlinesInRange(params: {
  filePath: string;
  start: number;
  end: number;
}): Promise<number> {
  if (params.end <= params.start) {
    return 0;
  }
  let handle: FileHandle | null = null;
  try {
    handle = await fs.open(params.filePath, "r");
    const buffer = Buffer.alloc(SESSION_DELTA_READ_CHUNK_BYTES);
    let offset = params.start;
    let count = 0;
    while (offset < params.end) {
      const toRead = Math.min(buffer.length, params.end - offset);
      const { bytesRead } = await handle.read(buffer, 0, toRead, offset);
      if (bytesRead <= 0) {
        break;
      }
      const textChunk = buffer.toString("utf8", 0, bytesRead);
      count += countNewlinesFromChunk(textChunk);
      offset += bytesRead;
    }
    return count;
  } catch {
    return 0;
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
  }
}

export function resolveSessionDeltaThresholds(
  cfg: AnchorClawConfig | undefined,
): SessionDeltaThresholds {
  const deltaBytes = cfg?.sessions?.sync?.deltaBytes;
  const deltaMessages = cfg?.sessions?.sync?.deltaMessages;
  return {
    deltaBytes:
      typeof deltaBytes === "number" && Number.isInteger(deltaBytes) && deltaBytes >= 0
        ? deltaBytes
        : DEFAULT_SESSION_DELTA_BYTES,
    deltaMessages:
      typeof deltaMessages === "number" && Number.isInteger(deltaMessages) && deltaMessages >= 0
        ? deltaMessages
        : DEFAULT_SESSION_DELTA_MESSAGES,
  };
}
