export type MemoryLookupReference = {
  lookup: string;
  fromLine?: number;
  lineCount?: number;
};

const MEMORY_LINE_REFERENCE_RE = /^(.*)#L([1-9]\d*)(?:-L([1-9]\d*))?$/;

export function parseMemoryLookupReference(rawLookup: string): MemoryLookupReference {
  const trimmed = rawLookup.trim();
  const match = MEMORY_LINE_REFERENCE_RE.exec(trimmed);
  if (!match) {
    return { lookup: trimmed };
  }

  const lookup = match[1]?.trim() ?? "";
  const fromLine = Number(match[2]);
  const endLine = match[3] ? Number(match[3]) : undefined;
  if (
    !lookup ||
    !Number.isSafeInteger(fromLine) ||
    (endLine !== undefined && (!Number.isSafeInteger(endLine) || endLine < fromLine))
  ) {
    return { lookup: trimmed };
  }

  return {
    lookup,
    fromLine,
    ...(endLine !== undefined ? { lineCount: endLine - fromLine + 1 } : {}),
  };
}
