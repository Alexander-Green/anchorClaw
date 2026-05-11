import type { PostgresPool } from "../postgres.js";

// MVP: prompt injection only supports fact/note (MEMORY.md role).
type MemoryItemType = "fact" | "note";

export type PromptMemoryItem = {
  id: string;
  type: MemoryItemType | string;
  title: string | null;
  content: string;
  importance: number;
  updatedAt: string;
};

export async function queryPromptMemoryItems(params: {
  pool: PostgresPool;
  userId: string;
  workspaceId: string;
  limit: number;
  types?: string[];
}): Promise<PromptMemoryItem[]> {
  const types = params.types?.length ? params.types : null;
  const result = await params.pool.query<{
    id: string;
    type: string;
    title: string | null;
    content: string;
    importance: number;
    updated_at: string;
  }>(
    `
    SELECT id, type, title, content, importance, updated_at
    FROM memory_items
    WHERE user_id = $1
      AND workspace_id = $2
      AND status = 'active'
      AND ($4::text[] IS NULL OR type::text = ANY($4::text[]))
    ORDER BY
      CASE type::text
        WHEN 'fact' THEN 1
        WHEN 'note' THEN 2
        ELSE 100
      END ASC,
      importance DESC,
      updated_at DESC,
      id ASC
    LIMIT $3
  `,
    [params.userId, params.workspaceId, params.limit, types],
  );

  return result.rows.map((row: {
    id: string;
    type: string;
    title: string | null;
    content: string;
    importance: number;
    updated_at: string;
  }) => ({
    id: row.id,
    type: row.type,
    title: row.title,
    content: row.content,
    importance: row.importance,
    updatedAt: row.updated_at,
  }));
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars))}…`;
}

const PROMPT_TRUNCATION_HEAD_RATIO = 0.75;
const PROMPT_TRUNCATION_TAIL_RATIO = 0.25;

export function buildPromptMemorySection(params: {
  items: PromptMemoryItem[];
  maxTotalChars: number;
  maxTitleChars: number;
  policy?: {
    /**
     * Per-type inclusion limits. Types not listed default to 0 (not injected).
     * Example: { fact: 6, note: 4 }
     */
    maxItemsByType: Record<string, number>;
    /**
     * Per-type character budgets for the item body (content). Types not listed use `defaultMaxItemChars`.
     */
    maxItemCharsByType?: Record<string, number>;
    /** Fallback content cap when a type is included but has no explicit cap. */
    defaultMaxItemChars: number;
  };
}): string[] {
  const lines: string[] = [];
  if (params.items.length === 0) {
    return lines;
  }

  lines.push("## Durable Memory (AnchorClaw/Postgres)");
  lines.push("Use these as durable facts/preferences. Do not treat them as transient chat messages.");
  lines.push("");

  const policy = params.policy ?? {
    // MVP default policy: focus on facts and notes; keep other types opt-in explicitly.
    maxItemsByType: { fact: 6, note: 4 },
    defaultMaxItemChars: 1_200,
  };

  const renderHeader = (title: string | undefined, type: string, id: string) =>
    `- (${type}) ${title ?? id}`;

  const renderBlock = (item: PromptMemoryItem): { type: string; block: string } => {
    const remainingTitle = item.title ? truncate(item.title.trim(), params.maxTitleChars) : undefined;
    const header = renderHeader(remainingTitle, item.type, item.id);
    const maxItemChars =
      policy.maxItemCharsByType && typeof policy.maxItemCharsByType[item.type] === "number"
        ? Math.max(1, Math.floor(policy.maxItemCharsByType[item.type]!))
        : policy.defaultMaxItemChars;
    const body = truncate(item.content.trim(), maxItemChars);
    const renderedBody = `  ${body.replaceAll("\n", "\n  ")}`;
    return { type: item.type, block: `${header}\n${renderedBody}\n\n` };
  };

  const baseUsed = lines.join("\n").length;
  const remainingByType = new Map<string, number>(
    Object.entries(policy.maxItemsByType).map(([type, count]) => [type, Math.max(0, Math.floor(count))]),
  );

  // First pass: attempt to render in-order without truncation.
  let used = baseUsed;
  const renderedInOrder: string[] = [...lines];
  for (const item of params.items) {
    const remaining = remainingByType.get(item.type) ?? 0;
    if (remaining <= 0) {
      continue;
    }
    const { block } = renderBlock(item);
    if (used + block.length > params.maxTotalChars) {
      break;
    }
    renderedInOrder.push(...block.trimEnd().split("\n"), "");
    used += block.length;
    remainingByType.set(item.type, remaining - 1);
  }

  const renderedInOrderText = renderedInOrder.join("\n");
  if (renderedInOrderText.length <= params.maxTotalChars) {
    if (renderedInOrder.at(-1) === "") {
      renderedInOrder.pop();
    }
    return renderedInOrder;
  }

  // Second pass: OpenClaw-style truncation (head + marker + tail).
  const markerLines = [
    "",
    "[...durable memory truncated; use memory_search/memory_get for full content...]",
    "",
  ];
  const markerLen = markerLines.join("\n").length;

  // Reserve space for header and marker, then split remaining budget into head/tail.
  const contentBudget = Math.max(0, params.maxTotalChars - baseUsed - markerLen);
  const headBudget = Math.floor(contentBudget * PROMPT_TRUNCATION_HEAD_RATIO);
  const tailBudget = Math.floor(contentBudget * PROMPT_TRUNCATION_TAIL_RATIO);

  const blocks = params.items.map((item) => ({ item, ...renderBlock(item) }));
  const headLines: string[] = [];
  const tailLines: string[] = [];
  const headItemIds = new Set<string>();

  const remainingForHead = new Map<string, number>(remainingByType);
  let headUsed = 0;
  for (const { item, type, block } of blocks) {
    const remaining = remainingForHead.get(type) ?? 0;
    if (remaining <= 0) {
      continue;
    }
    if (headUsed + block.length > headBudget) {
      break;
    }
    headLines.push(...block.trimEnd().split("\n"), "");
    headUsed += block.length;
    remainingForHead.set(type, remaining - 1);
    headItemIds.add(item.id);
  }

  const remainingForTail = new Map<string, number>(remainingForHead);
  let tailUsed = 0;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const { item, type, block } = blocks[i]!;
    // Avoid overlapping the head region when the budgets are large or the list is small.
    if (headItemIds.has(item.id)) {
      continue;
    }
    const remaining = remainingForTail.get(type) ?? 0;
    if (remaining <= 0) {
      continue;
    }
    if (tailUsed + block.length > tailBudget) {
      continue;
    }
    // Prepend so tail keeps original order.
    tailLines.unshift("", ...block.trimEnd().split("\n"));
    tailUsed += block.length;
    remainingForTail.set(type, remaining - 1);
  }
  while (tailLines.at(0) === "") {
    tailLines.shift();
  }

  const finalLines = [...lines, ...headLines, ...markerLines, ...tailLines];
  // Hard clamp if accounting drifted due to separators.
  const finalText = finalLines.join("\n");
  if (finalText.length > params.maxTotalChars) {
    const clamped = finalText.slice(0, params.maxTotalChars);
    return clamped.split("\n");
  }
  if (finalLines.at(-1) === "") {
    finalLines.pop();
  }
  return finalLines;
}
