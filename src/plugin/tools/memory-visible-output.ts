type RetrievalMode = string;

type Hit = {
  path?: string;
  score?: number;
  snippet?: string;
  corpus?: string;
  title?: string;
};

export function formatSearchLikeVisibleOutput(params: {
  hits: Hit[];
  retrievalMode: RetrievalMode;
  queryMode: "exact_value" | "contextual";
  exactTop1: boolean;
  exactTop1Value: string | null;
  recommendedAction: "return_exact" | "inspect_top" | "stop_not_found";
  provider: string;
  model: string;
  broadContext?: boolean;
}) {
  const { hits } = params;
  const topCandidates = hits
    .slice(0, 5)
    .map((hit) => {
      const title = typeof (hit as any).title === "string" ? (hit as any).title.trim() : "";
      const snippet = typeof hit.snippet === "string" ? hit.snippet.trim() : "";
      return title || snippet;
    })
    .filter((value) => value.length > 0);

  const results = hits.map((hit) => {
    const path = typeof hit.path === "string" ? hit.path : "";
    const snippetRaw = typeof hit.snippet === "string" ? hit.snippet : "";
    const corpus = typeof hit.corpus === "string" ? hit.corpus : "memory";
    const startLine = 1;
    const endLine = 1;
    const citation = path ? `${path}#L${startLine}` : "";
    const sourceLabel = path ? `\n\nSource: ${corpus === "daily" ? "DB daily entry " : ""}${citation}` : "";
    return {
      path,
      startLine,
      endLine,
      score: typeof hit.score === "number" ? hit.score : 0,
      snippet: snippetRaw ? `${snippetRaw}${sourceLabel}` : "",
      source: hit.corpus === "sessions" ? "sessions" : hit.corpus === "daily" ? "daily" : "memory",
      citation,
      corpus,
    };
  });

  const summary =
    results.length === 0
      ? `No results found. recommendedAction=${params.recommendedAction}; retrievalMode=${params.retrievalMode}.`
      : `Found ${results.length} result${results.length === 1 ? "" : "s"}. recommendedAction=${params.recommendedAction}; retrievalMode=${params.retrievalMode}.`;
  const lines = [summary];
  if (params.exactTop1Value) {
    lines.push(`Top exact match: ${params.exactTop1Value}`);
  }
  for (const [index, result] of results.entries()) {
    const label = result.citation ? `${result.path}#L${result.startLine}` : result.path;
    const corpusLabel = result.corpus === "daily" ? "daily DB entry" : result.corpus;
    lines.push("");
    lines.push(`${index + 1}. [${corpusLabel}] ${label} (score ${result.score.toFixed(3)})`);
    if (result.snippet) {
      lines.push(result.snippet);
    }
  }
  if (params.broadContext) {
    lines.push("");
    lines.push("Note: empty-query recall is broad context, not exact evidence.");
  }

  return lines.join("\n");
}

export function buildSearchLikeDetailsEnvelope(params: {
  hits: Hit[];
  retrievalMode: RetrievalMode;
  queryMode: "exact_value" | "contextual";
  exactTop1: boolean;
  exactTop1Value: string | null;
  recommendedAction: "return_exact" | "inspect_top" | "stop_not_found";
  provider: string;
  model: string;
  broadContext?: boolean;
}) {
  const { hits } = params;
  const topCandidates = hits
    .slice(0, 5)
    .map((hit) => {
      const title = typeof hit.title === "string" ? hit.title.trim() : "";
      const snippet = typeof hit.snippet === "string" ? hit.snippet.trim() : "";
      return title || snippet;
    })
    .filter((value) => value.length > 0);

  const results = hits.map((hit) => {
    const path = typeof hit.path === "string" ? hit.path : "";
    const snippetRaw = typeof hit.snippet === "string" ? hit.snippet : "";
    const corpus = typeof hit.corpus === "string" ? hit.corpus : "memory";
    const startLine = 1;
    const endLine = 1;
    const citation = path ? `${path}#L${startLine}` : "";
    const sourceLabel = path ? `\n\nSource: ${corpus === "daily" ? "DB daily entry " : ""}${citation}` : "";
    return {
      path,
      startLine,
      endLine,
      score: typeof hit.score === "number" ? hit.score : 0,
      snippet: snippetRaw ? `${snippetRaw}${sourceLabel}` : "",
      source: hit.corpus === "sessions" ? "sessions" : hit.corpus === "daily" ? "daily" : "memory",
      citation,
      corpus,
    };
  });

  return {
    recommendedAction: params.recommendedAction,
    queryMode: params.queryMode,
    exactTop1Value: params.exactTop1Value,
    topCandidates,
    results,
    provider: params.provider,
    model: params.model,
    citations: "auto",
    debug: {
      backend: "anchorclaw",
      effectiveMode: params.retrievalMode,
      hits: results.length,
    },
    meta: {
      retrievalMode: params.retrievalMode,
      queryMode: params.queryMode,
      semantic: false,
      exactTop1: params.exactTop1,
      exactTop1Value: params.exactTop1Value,
      recommendedAction: params.recommendedAction,
      ...(params.broadContext
        ? {
            broadContext: true,
            notExactEvidence: true,
            note: "empty-query recall is broad context and should not be used as exact marker/id/key evidence",
          }
        : {}),
    },
  };
}
