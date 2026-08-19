const SESSION_MEMORY_TOOL_DIRECTIVE_PREFIX = String.raw`(?:(?:\|DSML\|)|(?:\uFF5CDSML\uFF5C))?`;
const SESSION_MEMORY_TOOL_DIRECTIVE_KIND = String.raw`(?:tool_calls?|function_calls?|tool_use_error)`;
const SESSION_MEMORY_DROP_BLOCK_RE = new RegExp(
  String.raw`<${SESSION_MEMORY_TOOL_DIRECTIVE_PREFIX}${SESSION_MEMORY_TOOL_DIRECTIVE_KIND}\b[^>]*>` +
    String.raw`[\s\S]*?(?:<\/${SESSION_MEMORY_TOOL_DIRECTIVE_PREFIX}${SESSION_MEMORY_TOOL_DIRECTIVE_KIND}>|$)`,
  "giu",
);
const SESSION_MEMORY_ROLE_DIRECTIVE_BLOCK_RE = /<(system|assistant|user)\b[^>]*>[\s\S]*?<\/\1>/giu;
const SESSION_MEMORY_ROLE_DIRECTIVE_TAG_RE = /<\/?(?:system|assistant|user)\b[^>]*>/giu;
const SESSION_MEMORY_MEDIA_PLACEHOLDER_RE = /(^|\n)\s*<media:[^>]+>(?:\s*\([^)]*\))?\s*/giu;
const SESSION_MEMORY_TRAILING_NO_REPLY_RE = /(?:^|\n)\s*NO_REPLY\s*$/iu;
const SESSION_MEMORY_ANY_NO_REPLY_RE = /\bNO_REPLY\b/giu;
const MODEL_SPECIAL_TOKEN_RE = /<[|｜][^|｜]*[|｜]>/gu;
const SESSION_CAPTURE_MESSAGE_RE = /^(user|assistant):(?:\s|$)(.*)$/u;
const EARLIER_MESSAGES_MARKER = "...[earlier session messages omitted]...";

export type SessionCaptureMessage = {
  role: "user" | "assistant";
  content: string;
};

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringifyMessagePart(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }
  const part = value as Record<string, unknown>;
  return nonEmptyString(part.text) ?? nonEmptyString(part.content) ?? nonEmptyString(part.value) ?? "";
}

function extractMessageContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    for (const part of value) {
      const text = stringifyMessagePart(part);
      if (text) {
        return text;
      }
    }
    return "";
  }
  return value && typeof value === "object" ? stringifyMessagePart(value) : "";
}

function isNoReplyMarker(text: string): boolean {
  const trimmed = text.trim();
  if (/^NO_REPLY$/iu.test(trimmed)) {
    return true;
  }
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return false;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const action =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).action
        : undefined;
    return Boolean(
      parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        Object.keys(parsed).length === 1 &&
        typeof action === "string" &&
        action.trim().toUpperCase() === "NO_REPLY",
    );
  } catch {
    return false;
  }
}

export function sanitizeSessionCaptureText(
  text: string,
  options: { stripAllNoReplyMarkers?: boolean } = {},
): string | null {
  if (isNoReplyMarker(text)) {
    return null;
  }
  let sanitized = text
    .replace(MODEL_SPECIAL_TOKEN_RE, "")
    .replace(SESSION_MEMORY_DROP_BLOCK_RE, "")
    .replace(SESSION_MEMORY_ROLE_DIRECTIVE_BLOCK_RE, "")
    .replace(SESSION_MEMORY_ROLE_DIRECTIVE_TAG_RE, "")
    .replace(SESSION_MEMORY_MEDIA_PLACEHOLDER_RE, "$1")
    .replace(SESSION_MEMORY_TRAILING_NO_REPLY_RE, "");
  if (options.stripAllNoReplyMarkers) {
    sanitized = sanitized.replace(SESSION_MEMORY_ANY_NO_REPLY_RE, "");
  }
  sanitized = sanitized.replace(/[ \t]+\n/gu, "\n").replace(/\n{3,}/gu, "\n\n").trim();
  return sanitized || null;
}

function hasInterSessionUserProvenance(message: Record<string, unknown>): boolean {
  if (message.role !== "user") {
    return false;
  }
  const provenance = message.provenance;
  return Boolean(
    provenance &&
      typeof provenance === "object" &&
      (provenance as Record<string, unknown>).kind === "inter_session",
  );
}

function isDeliveryMirror(message: Record<string, unknown>): boolean {
  return message.role === "assistant" && message.provider === "openclaw" && message.model === "delivery-mirror";
}

function truncateMessage(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 20)).trimEnd()}\n[truncated]`;
}

export function normalizeSessionCaptureMessages(params: {
  messages: unknown;
  maxMessages: number;
  maxMessageChars: number;
}): SessionCaptureMessage[] {
  if (!Array.isArray(params.messages)) {
    return [];
  }

  const normalized: SessionCaptureMessage[] = [];
  let lastAssistantText: string | undefined;
  for (const raw of params.messages) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const message = raw as Record<string, unknown>;
    const role = nonEmptyString(message.role) ?? nonEmptyString(message.type);
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    if (hasInterSessionUserProvenance(message)) {
      continue;
    }
    if (role === "user") {
      lastAssistantText = undefined;
    }
    const rawContent = extractMessageContent(message.content).trim();
    if (!rawContent || rawContent.startsWith("/")) {
      continue;
    }
    const sanitized = sanitizeSessionCaptureText(rawContent, {
      // Session captures are later used as prompt context. Preserve the surrounding
      // prose, but never persist the transport-level silent-reply control token.
      stripAllNoReplyMarkers: true,
    });
    if (!sanitized) {
      continue;
    }
    if (isDeliveryMirror(message) && sanitized === lastAssistantText) {
      continue;
    }
    const content = truncateMessage(sanitized, Math.max(1, params.maxMessageChars));
    normalized.push({ role, content });
    if (role === "assistant") {
      lastAssistantText = sanitized;
    }
  }

  return normalized.slice(-Math.max(0, Math.trunc(params.maxMessages)));
}

export function parseStoredSessionCaptureMessages(content: string): SessionCaptureMessage[] {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const summaryIndex = lines.findIndex((line) => line.trim() === "### Conversation Summary");
  const messages: SessionCaptureMessage[] = [];
  let current: { role: "user" | "assistant"; lines: string[] } | null = null;

  const flush = () => {
    if (!current) {
      return;
    }
    const sanitized = sanitizeSessionCaptureText(current.lines.join("\n"), {
      stripAllNoReplyMarkers: true,
    });
    if (sanitized) {
      const previous = messages.at(-1);
      if (!(current.role === "assistant" && previous?.role === "assistant" && previous.content === sanitized)) {
        messages.push({ role: current.role, content: sanitized });
      }
    }
    current = null;
  };

  for (const line of lines.slice(summaryIndex >= 0 ? summaryIndex + 1 : 0)) {
    const match = SESSION_CAPTURE_MESSAGE_RE.exec(line);
    if (match) {
      flush();
      current = {
        role: match[1] as "user" | "assistant",
        lines: [match[2] ?? ""],
      };
    } else if (current) {
      current.lines.push(line);
    }
  }
  flush();
  return messages;
}

export function selectRecentSessionCaptureMessages(params: {
  messages: SessionCaptureMessage[];
  maxChars: number;
}): string {
  const maxChars = Math.max(0, Math.trunc(params.maxChars));
  if (maxChars === 0 || params.messages.length === 0) {
    return "";
  }

  const rendered = params.messages.map((message) => `${message.role}: ${message.content}`);
  const selected: string[] = [];
  let used = 0;
  for (let index = rendered.length - 1; index >= 0; index -= 1) {
    const block = rendered[index]!;
    const separatorChars = selected.length > 0 ? 1 : 0;
    if (used + separatorChars + block.length > maxChars) {
      break;
    }
    selected.unshift(block);
    used += separatorChars + block.length;
  }
  if (selected.length === 0) {
    return "";
  }

  const omitted = selected.length < rendered.length;
  if (omitted && EARLIER_MESSAGES_MARKER.length + 1 + used <= maxChars) {
    selected.unshift(EARLIER_MESSAGES_MARKER);
  }
  return selected.join("\n");
}
