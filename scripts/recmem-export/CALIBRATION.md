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
| `--merge_with_epi_thresh` | **0.88** (at the default, 21 of 33 episodes carry no lineage and only 17% of semantic facts resolve) |
| Verified how | the whole pipeline was run offline with a stub LLM — 40 LLM calls vs 108, 90% exact lineage vs 17% |

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

### Merge gate — measured against the real pipeline, and my offline proxy was wrong

The offline sweep predicted 162 merges at the default 0.7 and "one episode for
the whole conversation". **Both are wrong.** Running RecMem's actual `add_memory`
loop with real Ollama/bge-m3 vectors and real Qdrant stores (`dryrun.py`, a stub
LLM in place of the paid one) gives 21 merges and 33 episodes.

The proxy over-predicted merges by roughly 8x, and the reason is instructive: it
stood in the **mean of an episode's turns** for the episode vector, and a mean of
five turns lands near the centroid of the conversation's topic cloud, so
everything looks similar to it. A real episode — or even an extractive stand-in —
sits off-centre and matches far less. Averaging is not a neutral stand-in for
summarising.

The consolidation half of the simulation, by contrast, is **exact**: it predicted
20 fires and 90 turns left in the buffer at 0.78, and the real run produced 20 and
90. That half needs no proxy, which is precisely why it is trustworthy.

#### What the real pipeline does — conv-26, 214 turns

| | default `0.7 / 0.7` | calibrated `0.78 / 0.88` |
|---|---|---|
| LLM calls | **108** | **40** (−63%) |
| — episodic generation | 33 | 20 |
| — semantic extraction | 33 | 20 |
| — episodic merge | 21 | 0 |
| — semantic extraction during merge | 21 | 0 |
| subconscious layer | 13 (6% of turns) | **90 (42%)** |
| episodic layer | 33 | 20 |
| episodes **with no `raw_ids`** | **21 of 33** | **0 of 20** |
| semantic facts | 54 | 20 |
| `sourceHow: exact` | **9 / 54 = 17%** | **18 / 20 = 90%** |
| `ambiguous` / `unresolved` | 23 / 21 | 2 / 0 |

So the case for calibrating is smaller than the sweep suggested and still
decisive — just for a different reason than predicted. It is not that the default
collapses the episodic layer. It is that at the default, **21 of 33 episodes are
merge-generated and carry no lineage at all**, and only 17% of semantic facts can
be traced to the episode that produced them. The Memory Explorer's lineage view —
the whole point of V1 — would be mostly dead links. At 0.78/0.88 every episode
keeps its `raw_ids` and 90% of facts resolve exactly, for 63% of the LLM calls.

The remaining 2 `ambiguous` facts are an artefact of the stub, which emits
duplicate episode texts; a real model would not.

### A broken method the plan told me to use

`QdrantStore.get_collection_info()` raises against the pinned qdrant-client —
`'CollectionInfo' object has no attribute 'vectors_count'` — and swallows it,
returning `{}` for every collection. The M4 plan named it as the export
mechanism. `export.py` scrolls the collections directly instead, so it is
unaffected, but any layer-size number read through that method is silently zero.

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
  --model deepseek-v4-flash \
  --min_relevant_score 0.78 \
  --merge_with_epi_thresh 0.88 \
  --output_file out/run.json
```

`--conv_workers 1` is required for a per-conversation growth curve: above one
worker the token monitor is global and the curves interleave.

`deepseek-chat` / `deepseek-reasoner` are the **deprecated** names. As of the
2026-07-31 docs `GET /models` returns exactly two ids: `deepseek-v4-flash` and
`deepseek-v4-pro`.

**Do not use a reasoning model for `--model`.** Four of the five call sites send
`response_format={"type":"json_object"}` (`llm/openai.py:65`), which
`deepseek-reasoner` rejects; where a relay returns inline `<think>` blocks the
JSON parse fails, `rec_mem.py:463` reads `.get("facts", [])`, and the pipeline
stores **nothing** while logging an error. Silent, not loud.

The judge (`--judge_model`) still cannot be pointed at a separate provider — it
builds its own client at `llm_judge.py:20-28`, bypassing the `LLMClient`
abstraction. It will use whatever `OPENAI_API_BASE` says, so scoring needs a chat
model that host serves. `--eval_only` runs it separately if you want to defer it.

### What it should cost

`deepseek-v4-flash` is $0.14 / 1M input (cache miss), **$0.0028 cache hit**, $0.28
/ 1M output. Prefix caching is automatic and this pipeline re-sends history, so a
large share of input should hit.

The call count is now **measured, not estimated**: conv-26 at the calibrated
thresholds makes exactly **40** memory-pipeline calls (20 episodic generation + 20
semantic extraction, 0 merges), against 108 at the defaults. Add 199 answer calls
for that conversation's questions. At a few thousand input tokens each that lands
around **$0.10–0.20 for one conversation**, before caching helps. The original plan budgeted $5–10 on
`gpt-4o-mini`; this is one to two orders of magnitude under it, and embeddings
add nothing if they run locally.

Treat that as an estimate, not a quote — DeepSeek's pricing page carries an
explicit warning that a significant increase is planned. `--conv_limit 1` and the
`token_stats` file settle it for real before any second run.

## 5. Acceptance check before trusting the package

Run `export.py`, then require all four:

1. all three layers non-empty;
2. subconscious ≥ 20% of turns (the calibration predicts ~40%);
3. episodic in the 10–30 range for one conversation;
4. **≥ 60% of semantic facts resolving with `sourceHow: exact`** — this is the
   one that catches a merge gate set too low, because merge-path facts can only
   ever resolve as `suffix`, `ambiguous` or `unresolved`. Measured: the defaults
   score **17%** and fail it; 0.78/0.88 scores **90%**. Note that "resolvable at
   all" is the wrong test — the defaults reach 61% on that and are still unusable.

If (4) fails, raise `--merge_with_epi_thresh` and re-run; nothing else in the
pipeline reports that failure.
