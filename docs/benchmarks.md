# Benchmarks

How AnchorClaw's retrieval is measured, what the numbers mean, and how to
reproduce them.

## What is measured

Retrieval quality only: **does the search surface the right memory**. No model
generates an answer and no judge scores one. That keeps the measurement about
the part AnchorClaw owns, and it makes runs free and deterministic — the
full-text configuration needs no external service at all.

Metrics are **Recall@k** — was the relevant material among the first *k* results
— and **NDCG@k**, which additionally rewards ranking it higher.

## Dataset

[LongMemEval-S](https://github.com/xiaowu0162/longmemeval) (ICLR 2025): 500
questions, each accompanied by a long chat history of roughly 115k tokens with
the sessions containing the answer labelled. It covers information extraction,
multi-session reasoning, temporal reasoning, knowledge updates and abstention.

## Method

For each of the 500 questions:

1. a scope of its own is created, so no question can see another's history;
2. every session of the history is stored as one memory item through the normal
   `memory_store` write path, keyed by its session id;
3. the question text is passed to the normal `memory_search` read path;
4. the top 10 results are compared against the labelled sessions.

Both paths are the ones the plugin actually uses — nothing is reimplemented for
the benchmark.

Sessions, not individual turns, are the unit of indexing. That matters: the
benchmark paper measures lexical retrieval dropping from 0.634 to 0.472 Recall@5
when the unit shrinks to a single turn, while dense retrieval degrades far less.

## Results

PostgreSQL full-text search, no embeddings, no outbound traffic:

| | Recall@5 | Recall@10 | NDCG@5 | NDCG@10 |
|---|---|---|---|---|
| AnchorClaw, before 0.1.5 (`simple`) | 0.515 | 0.675 | 0.440 | 0.502 |
| **AnchorClaw 0.1.5** | **0.670** | **0.786** | **0.607** | **0.651** |
| BM25 (paper) | 0.634 | 0.710 | 0.516 | 0.540 |
| Stella V5 1.5B, dense (paper) | 0.720 | 0.794 | 0.594 | 0.615 |
| Contriever, dense (paper) | 0.723 | 0.823 | 0.634 | 0.663 |

Reference rows are from Table 9 of the [LongMemEval
paper](https://arxiv.org/pdf/2410.10813), session granularity, key = value.

Read this as: lexical search ahead of the BM25 baseline on every metric, ahead
of Stella on ranking quality, and behind Contriever mainly on recall — while
requiring no embedding provider and sending nothing off the machine.

## Why vendor percentages are not in that table

Published figures for hosted memory products — 94.6%, 92.8%, 57.5% and the like
— are **end-to-end QA accuracy**: retrieved context is given to a reader model
and an LLM judge grades the answer. That measures a different thing on a
different scale, and the result depends on which reader model was used. Putting
it beside Recall@k would be comparing unlike quantities. An end-to-end run would
be needed to produce a number in those terms.

## Reproducing

The harness lives outside the published package, in the project workspace:

```
PGURL=postgres://user:pass@host/anchorclaw_bench \
DATASET=./bench/data/longmemeval_s.json \
node bench/run-benchmark.mjs
```

It applies migrations, ingests, queries and prints the metrics, and writes every
raw result list to a JSONL file for inspection. `CASES=20` limits the run while
checking setup.

Run all 500. The first 150 questions score noticeably higher than the full set —
0.714 against 0.670 Recall@5 — so a truncated run flatters the result.

## Limitations

- **English only.** LongMemEval-S is an English corpus, so these numbers say
  nothing about retrieval quality in other languages. Correctness of the
  language handling is covered by tests; quality is not measured.
- **Retrieval, not answers.** A high Recall@k does not guarantee a good final
  answer; that also depends on the model reading the context.
- **Reference rows come from a different implementation** over the same dataset.
  Conditions are close but not identical.
