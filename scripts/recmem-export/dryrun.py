#!/usr/bin/env python3
"""Run RecMem's whole memory pipeline with REAL embeddings and a STUB LLM.

    PYTHONPATH=<RecMem> uv run --directory <RecMem> python dryrun.py \
      --locomo locomo10.json --conv 0 --stores /tmp/dryrun \
      --min-relevant-score 0.78 --merge-thresh 0.88


The point is not to produce memories worth reading — the stub's episodes are
canned text. The point is to run the real `add_memory` against real Ollama
vectors and real Qdrant stores, and see how often each branch actually fires,
so the offline simulation in `calibrate.py` can be checked against the
implementation rather than trusted.

Every LLM call is counted by op_type, so the run also prices the real thing:
that count times DeepSeek's per-call cost is the budget.
"""
import json
import os
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from calibrate import build_turns  # noqa: E402

from recmem.llm.base import LLMClient, LLMResponse, Message  # noqa: E402
from recmem.token_monitor import OPType, TokenUsage  # noqa: E402


def _extract(prompt: str, limit: int) -> str:
    """The conversational material out of a rendered prompt, head-truncated.

    The prompts wrap the raw turns in instructions; taking the tail of the
    prompt gets mostly the turns, which is what a summary would be about.
    """
    tail = prompt[-2500:]
    lines = [one.strip() for one in tail.split("\n") if one.strip().startswith("- ")]
    body = " ".join(lines) if lines else tail
    return body[:limit]


class StubLLM(LLMClient):
    """Canned JSON in the exact shapes the callers parse.

    `should_merge` is forced to "yes" so the merge branch fires whenever the
    threshold lets it — that is the assumption `calibrate.py` makes, so this run
    measures the same quantity and the two are comparable. A real model saying
    "no" would fall through to the consolidation gate, so these merge counts are
    the ceiling and the consolidation counts the floor.
    """

    def __init__(self, merge_says_yes: bool = True):
        self.calls: Counter = Counter()
        self.merge_says_yes = merge_says_yes

    def chat_completion(self, *, model, messages, temperature=0.0, json_mode=False,
                        monitor=None, op_type=None, max_retries=3, retry_delay=1.0):
        self.calls[op_type.name if op_type else "UNKNOWN"] += 1
        prompt = messages[0].content if messages else ""
        if op_type == OPType.EPISODIC_GENERATION:
            # Extractive, not canned: the merge gate compares a turn against
            # EPISODE vectors, so an episode of "STUB EPISODE 3" is orthogonal to
            # everything and the gate can never fire. Echoing the material the
            # episode is built from puts the vector in the right neighbourhood,
            # which is the closest an offline run gets to a real summary.
            body = {"episodes": [_extract(prompt, 600)]}
        elif op_type == OPType.EPISODIC_MERGE:
            body = {
                "should_merge": "yes" if self.merge_says_yes else "no",
                "merged_memory": _extract(prompt, 600),
            }
        elif op_type in (OPType.SEMANTIC_EXTRACTION,
                         OPType.SEMANTIC_EXTRACTION_DURING_MERGE):
            body = {"facts": [f"STUB FACT {self.calls[op_type.name]}"]}
        else:
            body = {"answer": "STUB"}
        content = json.dumps(body)
        # Token counts are invented; only the CALL counts are read from this run.
        usage = TokenUsage(prompt_tokens=0, completion_tokens=0, total_tokens=0)
        if monitor is not None:
            monitor.record_usage(usage, op_type)
        return LLMResponse(content=content, finish_reason="stop", usage=usage)


def main() -> None:
    import argparse

    p = argparse.ArgumentParser()
    p.add_argument("--locomo", type=Path, required=True)
    p.add_argument("--conv", type=int, default=0)
    p.add_argument("--min-relevant-score", type=float, default=0.78)
    p.add_argument("--merge-thresh", type=float, default=0.88)
    p.add_argument("--stores", type=Path, required=True)
    p.add_argument("--limit", type=int, default=None)
    args = p.parse_args()

    for name, sub in (("SUBCONSCIOUS_STORE", "subconscious_store"),
                      ("EPISODIC_STORE", "episodic_store"),
                      ("SEMANTIC_STORE", "semantic_store")):
        path = args.stores / sub
        path.mkdir(parents=True, exist_ok=True)
        os.environ[name] = str(path)
    os.environ["MODEL"] = "stub"

    from recmem.embedding.openai import OpenAIEmbedding
    from recmem.rec_mem import RecMem, RecMemConfig
    from recmem.token_monitor import TokenMonitor

    sample = json.loads(args.locomo.read_text(encoding="utf-8"))[args.conv]
    turns = build_turns(sample)
    if args.limit:
        turns = turns[: args.limit]

    stub = StubLLM()
    config = RecMemConfig(
        min_consolidation_cnt=5,
        min_relevant_score=args.min_relevant_score,
        merge_with_epi_thresh=args.merge_thresh,
        retrieve_raw_topk=10,
        retrieve_epi_topk=10,
        semantic_memory_topk=10,
        semantic_memory_threshold=0.0,
        disable_semantic_refinement=False,
    )
    rec = RecMem(config=config, embedder=OpenAIEmbedding(), llm_client=stub)
    rec.enable_token_monitoring()
    monitor = rec.token_monitor
    conv_id = "dryrun"
    rec.reset(conv_id)

    for i, turn in enumerate(turns):
        # `add_memory` re-wraps its argument, so strip the prefix this script's
        # shim already applied or the string would be double-wrapped.
        body = turn.split("[Message]: ", 1)[1]
        stamp = turn.split("[Message Timestamp]: ", 1)[1].split(" [Message]: ")[0]
        rec.add_memory(body, stamp, conv_id)
        if (i + 1) % 50 == 0:
            print(f"  {i+1}/{len(turns)} turns", flush=True)

    print(f"\nturns: {len(turns)}")
    print("LLM calls by op_type (this is what a real run would pay for):")
    for name, n in sorted(stub.calls.items(), key=lambda kv: -kv[1]):
        print(f"  {name:36} {n}")
    print(f"  {'TOTAL':36} {sum(stub.calls.values())}")

    for label, store in (("subconscious", rec.subconscious_memory),
                         ("episodic", rec.episodic_mem),
                         ("semantic", rec.semantic_memory)):
        info = store.vec_store.get_collection_info(conv_id)
        print(f"{label:14} points: {info.get('points_count')}")
    print(f"\nmonitor: messages={monitor.total_messages} "
          f"merged_messages={monitor.total_merged_messages} "
          f"save_ratio={monitor.average_message_save_ratio if hasattr(monitor,'average_message_save_ratio') else 'n/a'}")


if __name__ == "__main__":
    main()
