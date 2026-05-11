export type MemoryReadResult = {
  text: string;
  path: string;
  from: number;
  lines: number;
  truncated?: boolean;
  nextFrom?: number;
};

function buildContinuationNotice(params: { nextFrom: number | undefined }): string {
  const base =
    typeof params.nextFrom === "number"
      ? `[More content available. Use from=${params.nextFrom} to continue.]`
      : "[More content available. Requested excerpt exceeded the default maxChars budget.]";
  return `\n\n${base}`;
}

function fitLinesToCharBudget(params: { lines: string[]; maxChars: number }): {
  text: string;
  includedLines: number;
  hardTruncatedSingleLine: boolean;
} {
  const { lines, maxChars } = params;
  if (lines.length === 0) {
    return { text: "", includedLines: 0, hardTruncatedSingleLine: false };
  }

  let includedLines = lines.length;
  let text = lines.join("\n");
  while (includedLines > 1 && text.length > maxChars) {
    includedLines -= 1;
    text = lines.slice(0, includedLines).join("\n");
  }

  if (text.length <= maxChars) {
    return { text, includedLines, hardTruncatedSingleLine: false };
  }

  return {
    text: text.slice(0, maxChars),
    includedLines: 1,
    hardTruncatedSingleLine: true,
  };
}

export function buildMemoryReadResult(params: {
  content: string;
  relPath: string;
  from?: number;
  lines?: number;
  defaultLines: number;
  maxChars: number;
}): MemoryReadResult {
  const fileLines = params.content.split("\n");
  const start = Math.max(1, params.from ?? 1);
  const requestedCount = Math.max(
    1,
    params.lines ?? params.defaultLines,
  );
  const selectedLines = fileLines.slice(start - 1, start - 1 + requestedCount);
  const moreSourceLinesRemain = start - 1 + selectedLines.length < fileLines.length;

  const fitted = fitLinesToCharBudget({
    lines: selectedLines,
    maxChars: Math.max(1, params.maxChars),
  });
  const charCapTruncated =
    fitted.hardTruncatedSingleLine || fitted.includedLines < selectedLines.length;
  const nextFrom =
    !fitted.hardTruncatedSingleLine &&
    (moreSourceLinesRemain || fitted.includedLines < selectedLines.length)
      ? start + fitted.includedLines
      : undefined;
  const truncated = charCapTruncated || moreSourceLinesRemain;
  const text =
    truncated && fitted.text ? `${fitted.text}${buildContinuationNotice({ nextFrom })}` : fitted.text;

  return {
    text,
    path: params.relPath,
    from: start,
    lines: fitted.includedLines,
    ...(truncated ? { truncated: true } : {}),
    ...(typeof nextFrom === "number" ? { nextFrom } : {}),
  };
}
