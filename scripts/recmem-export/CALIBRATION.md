# Running RecMem without an OpenAI key — what has to change, and what the numbers are

Measured 2026-08-12 on `BAAI/bge-m3` (1024-dim), all ten LoCoMo conversations,
locally on Apple Silicon. No API key, no network, no cost. Everything below is
reproducible with `calibrate.py`.

## The short version

| | |
|---|---|
| Chat | DeepSeek works. `api.deepseek.com`, OpenAI-SDK compatible. |
| Embeddings | **DeepSeek has no embeddings endpoint at all.** A second provider is required. |
| Splitting the two | Needs a code change. Upstream reads ONE base_url for chat, embeddings *and* the judge. |
| `--min_relevant_score` | **0.78** (upstream default 0.7 is far too low for bge-m3) |
| `--merge_with_epi_thresh` | **0.88** (upstream default 0.7 produces ONE episode for a whole conversation) |

## 1. DeepSeek cannot supply embeddings

Not a gap in the docs — the capability does not exist:

- a request with a **valid key** to `https://api.deepseek.com/v1/embeddings` returns
  `404 {"error_msg": "Not Found. Please check the configuration."}`
  (`deepseek-ai/DeepSeek-R1` issue #652, closed "not planned"). Unauthenticated
  probes are useless here: auth runs before routing, so every path — including
  nonsense ones — returns 401.
- the string `embedding` appears on **zero of the 63 pages** in
  `api-docs.deepseek.com/sitemap.xml`.
- the `deepseek-ai` HuggingFace org has 102 models and **every text model is
  `text-generation`**. No sentence-similarity model exists to self-host either.
- no gateway resells one. OpenRouter carries 13 DeepSeek models, all `text→text`,
  and serves no embeddings for any provider.

## 2. The trap: one `base_url` for three clients

`recmem/llm/openai.py:32`, `recmem/embedding/openai.py:27` and
`evaluation/metrics/llm_judge.py:23` all read the same
`OPENAI_API_BASE` / `OPENAI_BASE_URL` pair.

So `OPENAI_API_BASE=https://api.deepseek.com` silently sends the **embedder**
there too. The 404 is swallowed by the retry loop (`embedding/openai.py:85-95`)
and surfaces as `RuntimeError: Failed to embed text after 3 retries` on the very
first `add_memory` — after the chat leg has already been proven to work, which
is the confusing part.

Worse, `OpenAIEmbedding.__init__` accepted only `(model, embedding_dims)` — no
`base_url` argument at all, unlike the chat client — so the two legs could not be
separated even in Python, let alone by configuration.

**`recmem-provider-split.patch` fixes this.** Apply it to a clean RecMem checkout:

```bash
git apply /path/to/recmem-provider-split.patch
```

It adds, all falling back to the previous behaviour when unset:

| variable | meaning |
|---|---|
| `EMBEDDING_API_BASE` | embeddings endpoint, checked before `OPENAI_API_BASE` |
| `EMBEDDING_API_KEY` | embeddings key, checked before `OPENAI_API_KEY` |
| `EMBEDDING_MODEL` | default `text-embedding-3-small` |
| `EMBEDDING_DIM` | default `1536`; also drives every Qdrant collection |
| `EMBEDDING_SEND_DIMENSIONS` | `dimensions=` is a `text-embedding-3-*` parameter and 400s elsewhere. Auto-off for other models; this forces it either way. |

It also routes the five hardcoded `1536` literals through one
`default_embedding_dim()` so the vector stores and the embedder cannot disagree.
Verified in both directions: with the new variables set, chat resolves to
DeepSeek and embeddings to a different host; with nothing set, everything
resolves exactly as upstream did.

## 3. The thresholds — why the defaults break silently

`rec_mem.py:388` compares a **raw cosine** against `min_relevant_score`, and
`episodic_memory.py:193` does the same with `merge_with_epi_thresh`. Both
defaults (0.7) were chosen for `text-embedding-3-small`. Every model has its own
similarity distribution, and a wrong threshold does not crash — the run
completes, writes all three stores and reports a `save_ratio`.

**The gate needs no LLM.** `add_memory` embeds the turn, searches the buffer,
counts neighbours over the threshold, and only calls a model *inside*
`_consolidate_memory`. So the whole dynamic can be replayed offline, for free —
which is what `calibrate.py` does, with the exact embedded string
(`[Message Timestamp]: … [Message]: [Speaker]: …`), the exact top-k, and the
exact buffer deletion.

### Consolidation gate — bge-m3 at 0.7 is nearly saturated

"Saturation" is the fire rate with **no threshold at all**: consolidation
triggers mechanically every `min_consolidation_cnt` turns, with no topical
selectivity whatsoever.

| conversation | turns | fires at 0.7 | % of saturation | buffer left |
|---|---|---|---|---|
| conv-26 | 214 | 36 | 86% | 11 (5%) |
| conv-30 | 188 | 33 | 89% | 9 (5%) |
| conv-41 | 340 | 56 | 82% | 14 (4%) |
| conv-42 | 323 | 53 | 83% | 27 (8%) |
| conv-43 | 349 | 49 | 71% | 54 (15%) |
| conv-44 | 343 | 58 | 85% | 17 (5%) |
| conv-47 | 355 | 46 | 65% | 72 (20%) |
| conv-48 | 347 | 55 | 80% | 32 (9%) |
| conv-49 | 260 | 42 | 81% | 19 (7%) |
| conv-50 | 292 | 46 | 79% | 15 (5%) |

At 0.7 the gate barely selects anything and the subconscious layer — one of the
three columns the Memory Explorer exists to show — ends at 4–20% of turns.

At **0.78** the gate runs at roughly 40–50% of saturation and the buffer retains
25–67% of turns: three populated layers.

> Worth recording: the prediction from bge-m3's model card was the **opposite** —
> that the gate would be stuck *off* and the episodic layer would come out empty,
> because the card's own example shows matching pairs at 0.6265 and 0.678. The
> measurement says the distribution over *these* strings sits higher (median
> 0.62–0.70 across the ten conversations) and the gate is stuck *on*. Predicting
> the direction from a model card does not work; measuring costs nothing.

### Merge gate — 0.7 collapses the episodic layer to one entry

| merge threshold | conv-26 | conv-42 | conv-47 |
|---|---|---|---|
| 0.70 (default) | 1 episode / 162 merges | 2 / 237 | 1 / 234 |
| 0.84 | 10 / 59 | 12 / 78 | 9 / 59 |
| **0.88** | **17 / 19** | **21 / 34** | **14 / 20** |
| 0.90 | 17 / 8 | 26 / 16 | 15 / 9 |

At the default, three quarters of all turns take the merge branch. That branch is
the one that **destroys lineage**: `episodic_memory.py:248` writes the merged
episode with no `extra_payload`, so it carries neither `conversation` nor
`raw_ids`, and the semantic fact it produces gets
`source = f"{conv}-{new_episodic}"`, which `export.py` can only resolve by suffix.
A run at 0.7 would produce exactly the demo that cannot be shown: one episode and
a pile of unlinked facts.

Caveat, stated because it matters: episodes are LLM rewrites that do not exist
offline, so `calibrate.py` stands in the **mean of the turns each episode
consolidated**. A real summary sits closer to its own turns than their mean does,
so these merge counts are a **floor** — the real firing rate is at least this
high. That is an argument for 0.88 rather than 0.84, not against the method.

## 4. The run

```bash
git apply recmem-provider-split.patch

export OPENAI_API_BASE=https://api.deepseek.com          # chat
export OPENAI_API_KEY=<deepseek key>
export EMBEDDING_API_BASE=<embedding provider base url>  # embeddings, separately
export EMBEDDING_API_KEY=<that provider's key>
export EMBEDDING_MODEL=BAAI/bge-m3
export EMBEDDING_DIM=1024
export LOCOMO_PATH=<path>/locomo10.json
export LOCOMO_SCORE_PATH=<dir>

python -m evaluation.run_experiments \
  --bench locomo --conv_limit 1 --conv_workers 1 \
  --model deepseek-chat \
  --min_relevant_score 0.78 \
  --merge_with_epi_thresh 0.88 \
  --output_file out/run.json
```

`--conv_workers 1` is required for a per-conversation growth curve: above one
worker the token monitor is global and the curves interleave.

**Do not use a reasoning model for `--model`.** Four of the five call sites send
`response_format={"type":"json_object"}` (`llm/openai.py:65`), which
`deepseek-reasoner` rejects; where a relay returns inline `<think>` blocks the
JSON parse fails, `rec_mem.py:463` reads `.get("facts", [])`, and the pipeline
stores **nothing** while logging an error. Silent, not loud.

The judge (`--judge_model`) still cannot be pointed at a separate provider — it
builds its own client at `llm_judge.py:20-28`, bypassing the `LLMClient`
abstraction. It will use whatever `OPENAI_API_BASE` says, so scoring needs a chat
model that host serves. `--eval_only` runs it separately if you want to defer it.

## 5. Acceptance check before trusting the package

Run `export.py`, then require all four:

1. all three layers non-empty;
2. subconscious ≥ 20% of turns (the calibration predicts ~40%);
3. episodic in the 10–30 range for one conversation;
4. **≥ 60% of semantic facts resolving with `sourceHow: exact`** — this is the
   one that catches a merge gate set too low, because merge-path facts can only
   ever resolve as `suffix` or `unresolved`.

If (4) fails, raise `--merge_with_epi_thresh` and re-run; nothing else in the
pipeline reports that failure.
