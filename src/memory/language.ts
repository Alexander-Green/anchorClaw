import { franc } from "franc";

/**
 * Resolves which PostgreSQL text search configuration to index a piece of
 * memory with.
 *
 * Background: everything used to be indexed with `simple`, which neither stems
 * nor removes stopwords. That is language neutral but costs a lot of recall —
 * `graduate` does not match `graduated`, and a natural question keeps every
 * function word as a required term under `plainto_tsquery`'s AND semantics.
 *
 * A wrong guess here is not dangerous. Documents and queries pass through the
 * same resolution, so a misrouted record stays *consistent* with the queries
 * that look for it and simply degrades toward the old `simple` behaviour.
 */

export const FALLBACK_CONFIG = "simple";

/**
 * ISO 639-3 (what `franc` returns) to the configurations PostgreSQL ships.
 *
 * Latin-script languages only, deliberately. Detection is used exclusively to
 * disambiguate within the Latin alphabet, which is where a script cannot help:
 * two thirds of the shipped configurations share it. Within any other script
 * PostgreSQL offers at most one or two configurations, and detection there is
 * measurably unreliable — Russian prose is reported as Serbian, Hindi as
 * Magahi — so the script table decides instead.
 */
const ISO3_TO_LATIN_CONFIG: Record<string, string> = {
  eus: "basque",
  cat: "catalan",
  dan: "danish",
  nld: "dutch",
  eng: "english",
  est: "estonian",
  fin: "finnish",
  fra: "french",
  deu: "german",
  hun: "hungarian",
  ind: "indonesian",
  gle: "irish",
  ita: "italian",
  lit: "lithuanian",
  nob: "norwegian",
  nno: "norwegian",
  nor: "norwegian",
  por: "portuguese",
  ron: "romanian",
  spa: "spanish",
  swe: "swedish",
  tur: "turkish",
};

/**
 * Script fallback, used where detection is blind — mainly short records.
 * Non-Latin scripts are tested first: mixed Russian/English text must resolve
 * to `russian`, whose configuration already routes ASCII tokens through the
 * English stemmer.
 *
 * Latin resolves to `english` because two thirds of the shipped configurations
 * share that script and an alphabet cannot separate them.
 */
const SCRIPT_CONFIGS: Array<{ pattern: RegExp; config: string }> = [
  { pattern: /[Ѐ-ӿ]/g, config: "russian" },
  { pattern: /[Ͱ-Ͽ]/g, config: "greek" },
  { pattern: /[؀-ۿ]/g, config: "arabic" },
  { pattern: /[ऀ-ॿ]/g, config: "hindi" },
  { pattern: /[԰-֏]/g, config: "armenian" },
  { pattern: /[஀-௿]/g, config: "tamil" },
  { pattern: /[֐-׿]/g, config: "yiddish" },
  { pattern: /[A-Za-z]/g, config: "english" },
];

/** Below this, `franc` guesses from too little evidence to be trusted. */
const MIN_CHARS_FOR_DETECTION = 40;

/** At or below this, indexing under several configurations is cheap. */
const SHORT_RECORD_MAX_CHARS = 24;

/**
 * Text that is mostly punctuation, paths or identifiers is not language
 * material. Detection fails loudly here — a line of JavaScript is reported as
 * Esperanto by one library and French by another — so skip it entirely.
 */
export function looksLikeCode(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }

  // A whole line that is nothing but a path or dotted identifier.
  if (/^[\w./@-]+\.\w{2,4}$/.test(trimmed)) {
    return true;
  }

  // Density, never presence. Testing for the presence of a code character was
  // measurably wrong: ordinary prose contains brackets and colons, and a single
  // parenthesis in a paragraph flagged the whole record as code — which sent
  // 17528 of 23864 benchmark records to the neutral configuration and erased the
  // entire improvement.
  //
  // Combining marks count as script material: Devanagari vowel signs are marks
  // rather than letters, and counting only \p{L} misreads Hindi prose as code.
  const meaningful = trimmed.replace(/\s+/g, "").length;
  if (meaningful === 0) {
    return false;
  }
  const script = (trimmed.match(/[\p{L}\p{M}]/gu) ?? []).length;
  if (script / meaningful < 0.5) {
    return true;
  }

  const codePunctuation = (trimmed.match(/[{}[\]();=<>|&]|::|=>|\/\//g) ?? []).length;
  return codePunctuation / meaningful > 0.04;
}

/**
 * Picks the *dominant* script, not merely a present one.
 *
 * Testing for presence looked fine on clean samples and was badly wrong on real
 * data: an English document containing a single Greek letter from a formula, or
 * one stray Cyrillic character, was routed to that language's stemmer and became
 * harder to find than it had been under `simple`.
 */
function configFromScript(text: string): string | null {
  let winner: string | null = null;
  let best = 0;
  for (const { pattern, config } of SCRIPT_CONFIGS) {
    const count = (text.match(pattern) ?? []).length;
    if (count > best) {
      best = count;
      winner = config;
    }
  }
  return winner;
}

/** Only meaningful for Latin text; see {@link ISO3_TO_LATIN_CONFIG}. */
function latinConfigFromDetection(text: string): string | null {
  if (text.length < MIN_CHARS_FOR_DETECTION) {
    return null;
  }
  let code: string;
  try {
    code = franc(text);
  } catch {
    return null;
  }
  if (!code || code === "und") {
    return null;
  }
  return ISO3_TO_LATIN_CONFIG[code] ?? null;
}

function withShortRecordFallbacks(config: string, isShort: boolean): string[] {
  if (!isShort) {
    return [config];
  }
  return config === FALLBACK_CONFIG ? [FALLBACK_CONFIG] : [config, FALLBACK_CONFIG];
}

/**
 * The configurations a record should be indexed with.
 *
 * Usually one. Short records also get `simple`, because the objection to
 * indexing under multiple configurations — index growth — is about long text;
 * on a one-word fact it costs a lexeme or two and keeps the exact form
 * searchable alongside the stem.
 */
export function resolveSearchConfigs(text: string): string[] {
  const trimmed = (text ?? "").trim();
  if (!trimmed || looksLikeCode(trimmed)) {
    return [FALLBACK_CONFIG];
  }

  const byScript = configFromScript(trimmed);
  if (!byScript) {
    return [FALLBACK_CONFIG];
  }

  const isShort = trimmed.length <= SHORT_RECORD_MAX_CHARS;

  // The script settles everything except Latin, where it cannot tell twenty
  // languages apart. Detection is consulted there and nowhere else.
  if (byScript !== "english") {
    return withShortRecordFallbacks(byScript, isShort);
  }

  return withShortRecordFallbacks(latinConfigFromDetection(trimmed) ?? "english", isShort);
}

/** The single configuration stored alongside a record, for query-side reuse. */
export function primarySearchConfig(text: string): string {
  return resolveSearchConfigs(text)[0] ?? FALLBACK_CONFIG;
}
