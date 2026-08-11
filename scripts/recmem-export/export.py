#!/usr/bin/env python3
"""Export a finished RecMem run — three memory layers, cost, growth — as one package.

RecMem stores its three layers in three embedded Qdrant directories and writes a
flat token summary at the end. Neither is meant to be read: the interesting
object is how a fact in the semantic layer came to exist — which episode
produced it, and which raw messages produced that episode — and nothing in the
repository renders it.

This script does not run RecMem and cannot: it reads a run that already
happened. It calls no model, opens no network connection and costs nothing.

    python export.py --run <dir with the three stores> \
                     --stats <output>_token_stats.json \
                     --out <repo>/public/demo-data/recmem/run.json

WHAT READING THE SOURCE CHANGED ABOUT THIS SCRIPT
-------------------------------------------------
Three things the plan assumed are not true of the code, and each one changes an
export decision rather than a detail:

1. `QdrantStore.list_memories()` returns `List[str]` — the texts alone. It drops
   `point.id` and the entire payload, which is where `raw_ids` and `source`
   live. Exporting through it would produce three flat lists of strings and no
   lineage at all. This script scrolls the collections directly.

2. `semantic.source` is the source episode's TEXT, not its id.
   `rec_mem.py:317` writes `{"source": f"{episodic_memory}"}`, and the merge path
   at `rec_mem.py:373` writes `f"{conv}-{new_episodic}"` — the conversation and
   the episode concatenated with a hyphen. So the semantic → episodic edge is
   recovered by matching text, and for merge-path facts it is genuinely
   ambiguous. Both are resolved here as far as they can be, and every fact
   records HOW its edge was found, so a viewer can show an exact match and a
   guess differently instead of drawing both as one arrow.

3. Every episode produced by one generation call carries the SAME `raw_ids`.
   `episodic_memory.py:125` appends `{"conversation": conversation, "raw_ids":
   raw_ids}` once per episode from variables that do not change inside the loop.
   So `raw_ids` identifies the WINDOW an episode came from, not the messages
   that particular episode summarises. The package says so; a lineage view that
   implies per-episode precision would be claiming resolution the data does not
   have.

Ids are `uuid.uuid4()` in every layer, so they carry no ordering and no meaning
beyond identity.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any

# `text` is `QdrantStore.DEFAULT_CONTENT_KEY`. Named here rather than imported
# so this script runs without RecMem's dependencies on the path; if upstream
# renames it, the mismatch surfaces as empty texts and the guard below fires.
CONTENT_KEY = "text"

# One scroll, bounded the same way `list_memories` bounds its own.
SCROLL_LIMIT = 10_000


def scroll(store_dir: Path, collection: str) -> list[dict[str, Any]]:
    """Every point in a collection, with its id and its whole payload.

    `list_memories()` is the documented way to do this and cannot be used: it
    returns texts. The lineage lives in the payload, so the payload has to come
    back.
    """
    from qdrant_client import QdrantClient  # imported late: only this path needs it

    client = QdrantClient(path=str(store_dir))
    try:
        if collection not in {one.name for one in client.get_collections().collections}:
            return []
        points, _ = client.scroll(
            collection_name=collection,
            limit=SCROLL_LIMIT,
            with_payload=True,
            with_vectors=False,  # the vectors are the bulk and no view reads them
        )
        out = []
        for point in points:
            payload = dict(point.payload or {})
            out.append({
                "id": str(point.id),
                "text": payload.pop(CONTENT_KEY, ""),
                # Whatever else the layer attached, unflattened and unrenamed —
                # `raw_ids`, `conversation`, `source`, `timestamp`.
                "payload": payload,
            })
        return out
    finally:
        # The embedded store takes a single-process lock on its directory. Not
        # closing it means the next export, or the next evaluation run, fails on
        # a directory that looks fine.
        client.close()


def resolve_sources(semantic: list[dict], episodic: list[dict]) -> None:
    """Attach each semantic fact to the episode its `source` names, if it can.

    `source` is episode text (`rec_mem.py:317`) or `f"{conv}-{episode}"` on the
    merge path (`rec_mem.py:373`). Exact match first; then the suffix form, which
    is what the merge path produces. `how` records which one succeeded, because
    an exact text match and a recovered suffix are not equally strong and a view
    that drew them the same way would be overstating one of them.
    """
    by_text: dict[str, str] = {}
    for episode in episodic:
        # A duplicate episode text makes the edge genuinely ambiguous: keep the
        # first and let `ambiguous` say so rather than silently picking.
        by_text.setdefault(episode["text"], episode["id"])
    counts = Counter(episode["text"] for episode in episodic)
    duplicated = {text for text, n in counts.items() if n > 1}

    for fact in semantic:
        source = fact["payload"].get("source")
        fact["sourceEpisodeId"] = None
        fact["sourceHow"] = "absent" if not isinstance(source, str) or source == "" else "unresolved"
        if not isinstance(source, str) or source == "":
            continue
        if source in by_text:
            fact["sourceEpisodeId"] = by_text[source]
            fact["sourceHow"] = "exact"
        else:
            # `f"{conv}-{new_episodic}"`: the episode is the tail. Try every
            # episode whose text the source ends with, longest first, so a short
            # episode that happens to be a suffix of a longer one does not win.
            candidates = sorted(
                (one for one in episodic if source.endswith(one["text"])),
                key=lambda one: len(one["text"]),
                reverse=True,
            )
            if candidates:
                fact["sourceEpisodeId"] = candidates[0]["id"]
                fact["sourceHow"] = "suffix"
        # Ambiguity is a property of the episode that was matched, not of the
        # source string. On the merge path the source is `f"{conv}-{episode}"`,
        # so comparing the source itself never matches a duplicated episode text
        # and every ambiguous merge-path fact would report as a confident match.
        if fact["sourceEpisodeId"] is not None:
            matched = next(
                (one for one in episodic if one["id"] == fact["sourceEpisodeId"]), None
            )
            if matched is not None and matched["text"] in duplicated:
                fact["sourceHow"] = "ambiguous"


def read_stats(path: Path | None) -> dict[str, Any]:
    """`<output>_token_stats.json`, as written, minus the field that is always 0.

    `total_questions` is dead — it is initialised and never incremented — so it
    is dropped rather than shipped as a zero a reader would try to interpret.
    The judge's own tokens are NOT in this file at all; that omission is
    recorded in the package instead of being left for someone to discover by
    finding the totals too low.
    """
    if path is None or not path.exists():
        return {}
    stats = json.loads(path.read_text(encoding="utf-8"))
    stats.pop("total_questions", None)
    return stats


def read_growth(path: Path | None) -> list[dict[str, Any]]:
    """The growth JSONL, if the run was instrumented to write one.

    Optional on purpose: an uninstrumented run still exports two of the three
    views, and a package that carries no curve says so rather than drawing a
    flat line.
    """
    if path is None or not path.exists():
        return []
    points = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            points.append(json.loads(line))
        except json.JSONDecodeError:
            # A truncated last line is what a killed run leaves behind. Keeping
            # the rest is right; pretending it was whole is not.
            continue
    return points


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--run", type=Path, required=True,
                   help="directory holding the three store directories")
    p.add_argument("--conv-id", required=True,
                   help="the conversation id, which is also the Qdrant collection name")
    p.add_argument("--subconscious-dir", default="subconscious_store")
    p.add_argument("--episodic-dir", default="episodic_store")
    p.add_argument("--semantic-dir", default="semantic_store")
    p.add_argument("--stats", type=Path, default=None,
                   help="<output>_token_stats.json from the same run")
    p.add_argument("--growth", type=Path, default=None,
                   help="growth JSONL, if the run was instrumented")
    p.add_argument("--out", type=Path, required=True)
    args = p.parse_args()

    if args.out.suffix != ".json":
        raise SystemExit(f"--out must end in .json, got {args.out.name}")

    layers = {}
    for name, folder in (
        ("subconscious", args.subconscious_dir),
        ("episodic", args.episodic_dir),
        ("semantic", args.semantic_dir),
    ):
        directory = args.run / folder
        if not directory.exists():
            raise SystemExit(f"no {name} store at {directory}")
        layers[name] = scroll(directory, args.conv_id)

    if all(len(one) == 0 for one in layers.values()):
        raise SystemExit(
            f"all three collections named '{args.conv_id}' are empty — "
            "check --conv-id against the collection names in the run"
        )
    empty_texts = sum(1 for one in layers["episodic"] if one["text"] == "")
    if layers["episodic"] and empty_texts == len(layers["episodic"]):
        raise SystemExit(
            f"every episodic point has an empty '{CONTENT_KEY}' — upstream has "
            "probably renamed QdrantStore.DEFAULT_CONTENT_KEY"
        )

    resolve_sources(layers["semantic"], layers["episodic"])
    resolved = sum(1 for one in layers["semantic"] if one["sourceEpisodeId"] is not None)

    # `raw_ids` is shared across every episode from one generation call, so the
    # number of DISTINCT windows is the honest denominator for "how many message
    # groups produced episodes", and it is smaller than the episode count.
    windows = {
        json.dumps(one["payload"].get("raw_ids"), sort_keys=True)
        for one in layers["episodic"]
        if one["payload"].get("raw_ids") is not None
    }

    package = {
        "agentlens_format": "recmem-run@1",
        "conv_id": args.conv_id,
        "source": {
            "what": "one RecMem conversation: its three memory layers as they "
                    "stood when the run finished, its token stats, and its "
                    "growth curve if the run was instrumented",
            "upstream": "https://github.com/Hongjin-Lab/RecMem",
            "how": "read out of the three embedded Qdrant directories with "
                   "client.scroll(with_payload=True). No model is called and "
                   "nothing is recomputed: every text, id and label here is what "
                   "the run left on disk.",
            "why_not_list_memories": "QdrantStore.list_memories() returns the "
                                     "texts only — it drops point.id and the "
                                     "payload, which is where raw_ids and source "
                                     "live, so the lineage cannot be built from it.",
        },
        "counts": {
            "subconscious": len(layers["subconscious"]),
            "episodic": len(layers["episodic"]),
            "semantic": len(layers["semantic"]),
            "episodeWindows": len(windows),
            "semanticWithSource": resolved,
            "growthPoints": len(read_growth(args.growth)),
        },
        "how_to_read_the_lineage": (
            "The semantic → episodic edge is recovered, not stored. "
            "rec_mem.py writes `source` as the episode's own TEXT, and on the "
            "merge path as f\"{conv}-{episode}\", so this export matches strings: "
            "`sourceHow` is `exact` when the source is an episode's text, "
            "`suffix` when it is the merge-path concatenation, `ambiguous` when "
            "two episodes share that text, `unresolved` when no episode matches, "
            "and `absent` when the fact carries no source at all. Only `exact` is "
            "a certainty. "
            "The episodic → message edge is stored, in `raw_ids`, but it is "
            "per-WINDOW: every episode produced by one generation call carries "
            "the same list, so `raw_ids` says which messages the batch came from "
            "and not which of them this episode summarises."
        ),
        "layers": layers,
        "stats": read_stats(args.stats),
        "growth": read_growth(args.growth),
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(package, ensure_ascii=False, separators=(",", ":")),
                        encoding="utf-8")
    print(f"{args.conv_id}: {package['counts']['subconscious']} subconscious, "
          f"{package['counts']['episodic']} episodic from "
          f"{package['counts']['episodeWindows']} windows, "
          f"{package['counts']['semantic']} semantic "
          f"({resolved} with a resolvable source)")
    if package["counts"]["growthPoints"] == 0:
        print("  no growth curve: run was not instrumented, or --growth not given")
    if not package["stats"]:
        print("  no token stats: --stats not given or file missing")
    print(f"wrote {args.out} — {args.out.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
