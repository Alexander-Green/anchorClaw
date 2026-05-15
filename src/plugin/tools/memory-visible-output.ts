type RetrievalMode = string;

type Hit = {
  path?: string;
  score?: number;
  snippet?: string;
  corpus?: string;
};

export function formatSearchLikeVisibleOutput(params: {
  hits: Hit[];
  retrievalMode: RetrievalMode;
  exactTop1: boolean;
  exactTop1Value: string | null;
  recommendedAction: "return_exact" | "inspect_top" | "stop_not_found";
  provider: string;
  model: string;
  broadContext?: boolean;
}) {
  const { hits } = params;
  const results = hits.map((hit) => {
    const path = typeof hit.path === "string" ? hit.path : "";
    const snippetRaw = typeof hit.snippet === "string" ? hit.snippet : "";
    const startLine = 1;
    const endLine = 1;
    const citation = path ? `${path}#L${startLine}` : "";
    const sourceLabel = path ? `\n\nSource: ${citation}` : "";
    return {
      path,
      startLine,
      endLine,
      score: typeof hit.score === "number" ? hit.score : 0,
      snippet: snippetRaw ? `${snippetRaw}${sourceLabel}` : "",
      source: hit.corpus === "sessions" ? "sessions" : "memory",
      citation,
      corpus: typeof hit.corpus === "string" ? hit.corpus : "memory",
    };
  });

  const envelope = {
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

  return JSON.stringify(envelope, null, 2);
}

