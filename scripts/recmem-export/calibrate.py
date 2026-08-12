#!/usr/bin/env python3
"""Find the consolidation threshold for a NON-OpenAI embedding model, offline.

RecMem's consolidation gate is a raw cosine comparison against a hardcoded 0.7
(`rec_mem.py:388`), and 0.7 was chosen for `text-embedding-3-small`. Every
embedding model has its own similarity distribution, so reusing 0.7 under a
different model is a coin flip with three faces:

  - gate stuck OFF  -> episodic and semantic layers come out empty
  - gate stuck ON   -> consolidation fires on nearly every turn, the subconscious
                       buffer never grows, the three layers collapse into one and
                       `save_ratio` (the demo's headline) goes to ~0
  - gate in band    -> the run means something

None of the three crashes. All three write three Qdrant stores and a token-stats
file, so the failure is discovered after the money is spent, if at all. This
script finds out first, for nothing.

THE ONE THING THAT MAKES THIS POSSIBLE: the gate needs no LLM. `add_memory`
embeds the turn, searches the subconscious buffer, counts neighbours over the
threshold, and only calls a model INSIDE `_consolidate_memory`. So the entire
gating dynamic — buffer growth, when it fires, how much it swallows — can be
replayed exactly, with embeddings alone.

    python calibrate.py --locomo locomo10.json --conv 0 --model BAAI/bge-m3

WHAT IS FAITHFUL HERE AND WHAT IS NOT
-------------------------------------
Faithful, because it is copied from the source rather than described:

  - the embedded string. `run_experiments.py` pairs each two messages
    (`message_a.to_string() + "\\n" + message_b.to_string()`), `to_string()` is
    `f"[{speaker}]: {content}"` with an image-caption variant
    (`conv_loader.py:19-20`), and `add_memory` then wraps it as
    `f"[Message Timestamp]: {timestamp} [Message]: {message}"` (`rec_mem.py:344`).
    Calibrating on bare message text would measure a different distribution —
    every string here carries the same constant prefix, which by itself lifts
    every pairwise similarity.
  - the gate. top-`gating_raw_topk` nearest from the buffer, count
    `score > threshold`, `+1`, compare with `min_consolidation_cnt`
    (`rec_mem.py:378-396`).
  - what consolidation does to the buffer: the matched entries are deleted and
    the new turn is NOT added (`_consolidate_memory` docstring, `rec_mem.py:258`).
    Getting this wrong would make the buffer grow monotonically and every
    threshold look usable.

NOT faithful, and flagged wherever it is reported:

  - the merge gate (`episodic_memory.py:193`) compares against EPISODE vectors,
    and episodes are LLM rewrites that do not exist offline. This script embeds
    `cat_raw_memories` — the exact string the LLM is given (`rec_mem.py:290`) —
    as a stand-in. It is what the episode is about, not what the episode says,
    so treat the merge number as an indication and not a measurement.
  - a merge that fires would return before the gate, so a stand-in that fires
    too eagerly would under-count consolidations. This script therefore reports
    the gate WITHOUT the merge branch as the primary curve, and the merge
    estimate separately.
"""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime
from pathlib import Path

import numpy as np

# `run_experiments.py:117-119`: the gate looks at twice the count it needs, so a
# turn can be judged against more neighbours than the number required to fire.
TOPK_MULTIPLIER = 2


def locomo_time(value: str) -> str:
    """`conv_loader.ConvLoader.locomo_time_to_datetime`, reproduced.

    Reproduced rather than imported so this script runs without RecMem's
    dependency tree. It has to match: the ISO timestamp is a prefix on every
    embedded string, so a different format is a different corpus.
    """
    value = " ".join(value.split())
    pattern = re.compile(
        r"^(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s+on\s+(\d{1,2})\s+([A-Za-z]+),?\s*(\d{4})$",
        re.IGNORECASE,
    )
    match = pattern.match(value)
    if match is None:
        return value
    hour, minute, meridiem, day, month_name, year = match.groups()
    hour = int(hour)
    minute = int(minute) if minute else 0
    if meridiem.lower() == "pm" and hour != 12:
        hour += 12
    if meridiem.lower() == "am" and hour == 12:
        hour = 0
    months = {
        m: i + 1
        for i, m in enumerate(
            "january february march april may june july august september "
            "october november december".split()
        )
    }
    month = months.get(month_name.lower())
    if month is None:
        return value
    return datetime(int(year), month, int(day), hour, minute).isoformat()


def to_string(msg: dict) -> str:
    """`conv_loader.Message.to_string()` (:19-20)."""
    caption = msg.get("blip_caption")
    if caption:
        return f"[{msg['speaker']}]: {msg['text']} [Showing Image]: {caption}"
    return f"[{msg['speaker']}]: {msg['text']}"


def build_turns(sample: dict) -> list[str]:
    """The exact strings `add_memory` embeds, in the order it embeds them."""
    conversation = sample["conversation"]
    session_keys = sorted(
        (k for k in conversation if k.startswith("session_") and not k.endswith("date_time")),
        key=lambda k: int(k.split("_")[1]),
    )
    turns: list[str] = []
    for key in session_keys:
        messages = conversation[key]
        if not isinstance(messages, list):
            continue
        stamp = locomo_time(conversation.get(f"{key}_date_time", ""))
        # `run_experiments.py`: LoCoMo is a two-speaker dialogue, so messages are
        # grouped in pairs, with a trailing odd message standing alone.
        i = 0
        while i < len(messages):
            if i + 1 < len(messages):
                body = to_string(messages[i]) + "\n" + to_string(messages[i + 1])
                i += 2
            else:
                body = to_string(messages[i])
                i += 1
            turns.append(f"[Message Timestamp]: {stamp} [Message]: {body}")
    return turns


def replay(
    vectors: np.ndarray,
    threshold: float,
    min_cnt: int,
    merge_threshold: float | None = None,
) -> dict:
    """`add_memory` end to end, exactly as `rec_mem.py:336-411` runs it, no LLM.

    With `merge_threshold`, the episodic merge branch is simulated too. That
    branch matters far beyond its cost: when it fires, the merged episode is
    written with NO `extra_payload` (`episodic_memory.py:248`), so it carries
    neither `conversation` nor `raw_ids`, and the semantic fact it produces gets
    `source = f"{conv}-{new_episodic}"`, which the exporter can only resolve by
    suffix. A run where merges dominate produces a Memory Explorer full of nodes
    with no lineage — the demo's headline view, empty of its point.

    THE PROXY, stated where it is used: an episode's real vector is the
    embedding of an LLM rewrite that does not exist offline. Here an episode is
    represented by the mean of the turns it consolidated, which is what the
    episode is ABOUT. A summary is typically closer to its own turns than their
    mean is, so this UNDER-estimates merge firing — read the merge column as a
    floor, not a measurement.
    """
    topk = min_cnt * TOPK_MULTIPLIER
    buffer: list[int] = []          # indexes still in the subconscious store
    consolidations: list[int] = []  # how many raw turns each one swallowed
    episodes: list[np.ndarray] = [] # proxy vectors, one per episode
    merges = 0

    for i in range(len(vectors)):
        # Step 1: the merge branch runs FIRST and returns early, so a turn it
        # claims never reaches the gate. Simulating the gate alone would
        # over-count consolidations by exactly the merges.
        if merge_threshold is not None and episodes:
            best = float(np.max(np.stack(episodes) @ vectors[i]))
            if best >= merge_threshold:
                merges += 1
                continue

        # Step 2: the gate.
        if buffer:
            # Cosine, because the vectors are L2-normalised and Qdrant is
            # configured `Distance.COSINE` (`qdrant.py:138`).
            scores = vectors[buffer] @ vectors[i]
            order = np.argsort(-scores)[:topk]
            over = [buffer[at] for at in order if scores[at] > threshold]
        else:
            over = []
        # `relevant_count = len(relevant_vec_ids) + 1`, then `>= min_cnt`.
        if len(over) + 1 >= min_cnt:
            consolidations.append(len(over) + 1)
            members = over + [i]
            vector = vectors[members].mean(axis=0)
            episodes.append(vector / np.linalg.norm(vector))
            drop = set(over)
            buffer = [at for at in buffer if at not in drop]
            # The new turn is NOT added on this path — see the docstring of
            # `_consolidate_memory`. Forgetting this makes every threshold look
            # workable, because the buffer would only ever grow.
        else:
            buffer.append(i)

    total = len(vectors)
    return {
        "threshold": threshold,
        "mergeThreshold": merge_threshold,
        "consolidations": len(consolidations),
        "merges": merges,
        "turnsSwallowed": sum(consolidations),
        "bufferLeft": len(buffer),
        "consolidationRate": len(consolidations) / total,
        "mergeRate": merges / total,
        # Every turn that neither consolidates nor merges took the zero-LLM
        # path. This is `save_ratio`, the number the demo leads with.
        "saveRatio": 1 - (len(consolidations) + merges) / total,
    }


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--locomo", type=Path, required=True, help="locomo10.json")
    p.add_argument("--conv", type=int, default=0, help="index into the LoCoMo list")
    p.add_argument("--model", default="BAAI/bge-m3")
    p.add_argument("--device", default="mps")
    p.add_argument("--min-consolidation-cnt", type=int, default=5,
                   help="RecMem's --min_consolidation_cnt (default 5)")
    p.add_argument("--merge-at", type=float, default=0.78,
                   help="consolidation threshold to hold fixed while sweeping the merge gate")
    p.add_argument("--out", type=Path, default=None, help="write the sweep as JSON")
    args = p.parse_args()

    sample = json.loads(args.locomo.read_text(encoding="utf-8"))[args.conv]
    turns = build_turns(sample)
    print(f"conversation {sample.get('sample_id')}: {len(turns)} turns "
          f"(what add_memory would be called with, in order)")
    print(f"first turn, as embedded:\n  {turns[0][:160]}...\n")

    from sentence_transformers import SentenceTransformer

    model = SentenceTransformer(args.model, device=args.device)
    vectors = model.encode(turns, batch_size=16, normalize_embeddings=True,
                           show_progress_bar=False, convert_to_numpy=True)
    print(f"embedded with {args.model}: {vectors.shape[0]} x {vectors.shape[1]} dims\n")

    # The distribution, before any threshold is chosen. This is the number that
    # explains every row below it.
    pairs = vectors @ vectors.T
    upper = pairs[np.triu_indices(len(vectors), k=1)]
    quantiles = [50, 75, 90, 95, 99]
    print("pairwise cosine over the whole conversation:")
    print(f"  min {upper.min():.3f}  mean {upper.mean():.3f}  max {upper.max():.3f}")
    print("  " + "  ".join(f"p{q}={np.percentile(upper, q):.3f}" for q in quantiles))
    print(f"  fraction above RecMem's default 0.7: {(upper > 0.7).mean():.1%}\n")

    print(f"gate replay (min_consolidation_cnt={args.min_consolidation_cnt}, "
          f"top_k={args.min_consolidation_cnt * TOPK_MULTIPLIER}):")
    print(f"  {'thresh':>7}  {'fires':>6}  {'swallowed':>10}  {'buffer left':>12}  {'rate':>7}")
    rows = []
    for threshold in [round(0.30 + 0.02 * i, 2) for i in range(31)]:
        row = replay(vectors, threshold, args.min_consolidation_cnt)
        rows.append(row)
        print(f"  {threshold:>7.2f}  {row['consolidations']:>6}  "
              f"{row['turnsSwallowed']:>10}  {row['bufferLeft']:>12}  "
              f"{row['consolidationRate']:>6.1%}")

    # The second gate, over the first. A merge returns before consolidation, so
    # these two thresholds are not independent and sweeping one alone hides it.
    print(f"\nboth gates, at consolidation threshold {args.merge_at:.2f} "
          f"(episode vectors are the PROXY described in the header — a floor):")
    print(f"  {'merge':>7}  {'merges':>7}  {'episodes':>9}  {'buffer left':>12}  {'save_ratio':>11}")
    merge_rows = []
    for merge_threshold in [round(0.60 + 0.02 * i, 2) for i in range(16)]:
        row = replay(vectors, args.merge_at, args.min_consolidation_cnt, merge_threshold)
        merge_rows.append(row)
        print(f"  {merge_threshold:>7.2f}  {row['merges']:>7}  {row['consolidations']:>9}  "
              f"{row['bufferLeft']:>12}  {row['saveRatio']:>10.1%}")

    if args.out is not None:
        args.out.write_text(json.dumps({
            "model": args.model,
            "sample_id": sample.get("sample_id"),
            "turns": len(turns),
            "dim": int(vectors.shape[1]),
            "pairwise": {
                "min": float(upper.min()),
                "mean": float(upper.mean()),
                "max": float(upper.max()),
                **{f"p{q}": float(np.percentile(upper, q)) for q in quantiles},
                "fractionAboveDefault0_7": float((upper > 0.7).mean()),
            },
            "sweep": rows,
            "mergeSweep": merge_rows,
            "mergeSweepAtConsolidation": args.merge_at,
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\nwrote {args.out}")


if __name__ == "__main__":
    main()
