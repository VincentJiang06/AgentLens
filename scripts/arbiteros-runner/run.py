#!/usr/bin/env python3
"""Replay ArbiterOS's red-team cases through its own policy kernel, offline.

ArbiterOS forked the whole of Langfuse to look at its traces. This produces the
same material in one JSON file that a static page can read.

The point of doing it this way: a red-team case on disk carries only `trace_id`,
`prior` and `current`. The taint labels — `prop_trustworthiness`,
`prop_confidentiality` — are not in the file; they are what the kernel *computes*
when the case is replayed through `InstructionBuilder` and the policy chain. So a
viewer built from the case files alone can show the attack script and nothing
else, and the propagation graph, which is the interesting object, needs a run.

`policy_test_harness.run_policy_replay_from_spec` is that run, and it touches no
model: no API key, no gateway, no network, no cost. It is the whole reason M3 is
free.

    uv run python <this>/run.py --out <repo>/public/demo-data/arbiteros/traces.json

Run it from the ArbiterOS-Kernel directory (the harness resolves config relative
to the working directory).
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import sys
from pathlib import Path


def load_manifest(kernel: Path) -> list[dict]:
    path = kernel / "redteam" / "_automation" / "case_manifest.json"
    manifest = json.loads(path.read_text(encoding="utf-8"))
    return [case for case in manifest["cases"] if case.get("enabled", True)]


def render(text: str, kernel: Path) -> str:
    """Rewrite a case's hardcoded paths onto this machine.

    Cases ship with `/root/redteam/...` in them. Several policies match on where
    a file lives, so a case replayed without this rewrite passes through the
    kernel untouched — the run succeeds, every case reports clean, and the
    dataset silently describes a policy engine that never fires. Replayed with
    it, the same suite intercepts what it was written to intercept.

    Same substitutions as `redteam/_automation/run_cases.py:render_case_text`,
    which is what the upstream batch runner does before every case.
    """
    home = Path.home().resolve()
    redteam = (kernel / "redteam").resolve()
    for old, new in [
        ("${REPO_ROOT}", str(kernel)),
        ("${REDTEAM_ROOT}", str(redteam)),
        ("${REDTEAM_WORKSPACE}", str((redteam / "workspace").resolve())),
        ("${HOME}", str(home)),
        ("${OPENCLAW_HOME}", str((home / ".openclaw").resolve())),
        ("/root/ArbiterOS-Kernel", str(kernel)),
        ("/root/redteam", str(redteam)),
        ("/root/.openclaw", str((home / ".openclaw").resolve())),
    ]:
        text = text.replace(old, new)
    return text


def taint_of(instruction: dict) -> dict:
    """The five fields a propagation graph needs, out of a much larger record."""
    security = instruction.get("security_type") or {}
    return {
        "trust": security.get("trustworthiness"),
        "conf": security.get("confidentiality"),
        # What the label became after flowing along the reference chain: trust
        # takes the minimum seen, confidentiality the maximum. Both are kept, so
        # a view can show which upstream step moved which.
        "propTrust": security.get("prop_trustworthiness"),
        "propConf": security.get("prop_confidentiality"),
        "reversible": security.get("reversible"),
        "risk": security.get("risk"),
        "authority": security.get("authority"),
    }


def scrub(value, kernel: Path):
    """Put the replay machine's paths back behind placeholders, everywhere.

    `render` rewrites the cases' `/root/...` onto this machine because several
    policies match on where a file lives — that substitution is what makes the
    replay faithful. But it also means the kernel's output is full of the
    operator's home directory, and this package is published. The paths go in so
    the policies fire, and come back out before anything is written.

    Applied to the whole structure rather than to `content` alone: the paths turn
    up in policy sources and in refusal messages too.
    """
    home = str(Path.home().resolve())
    swaps = [
        (str((kernel / "redteam").resolve()), "<redteam>"),
        (str(kernel), "<arbiteros-kernel>"),
        (str(Path(home) / ".openclaw"), "<openclaw-home>"),
        (home, "<home>"),
    ]
    if isinstance(value, str):
        for old, new in swaps:
            value = value.replace(old, new)
        return value
    if isinstance(value, list):
        return [scrub(one, kernel) for one in value]
    if isinstance(value, dict):
        return {key: scrub(one, kernel) for key, one in value.items()}
    return value


# What `apply_policy_enforcement_mode` writes when a gated policy reported it
# changed the response but never composed a message explaining why. It is a
# stand-in, not a judgement, and a case can carry it more than once when more
# than one gated policy contributes it.
PLACEHOLDER = "policy would have modified the response"


def refusal_text(verdict: dict) -> str | None:
    """The refusal a policy actually wrote, or None if it never wrote one.

    This is the distinction the counts turn on. `inactivate_error_type` being
    non-empty does not mean a policy decided to stop anything — for most cases
    in this suite it holds only PLACEHOLDER, written because PathBudgetPolicy
    re-serialised the response. Strip the stand-in; if nothing is left, no
    policy stated a reason, and counting the case as a detection overstates
    what the kernel did.
    """
    for field in ("errorType", "wouldBlock"):
        raw = verdict.get(field)
        if not isinstance(raw, str):
            continue
        rest = raw.replace(PLACEHOLDER, "").strip()
        if rest:
            return rest
    return None


def read_registry(kernel: Path) -> list[dict]:
    """`policy_registry.json`, as a name/enabled snapshot.

    This is the one fact the counts depend on that lives outside the traces: a
    policy's verdict is carried out or written down according to `enabled`, and
    a package that reports the gap without reporting the configuration is asking
    to be read as a property of the policies. The adapter used to hard-code
    "11 of 15" in prose; reading the file the replay actually ran against means a
    reader with a different registry gets their own numbers.
    """
    path = kernel / "arbiteros_kernel" / "policy_registry.json"
    if not path.exists():
        return []
    entries = json.loads(path.read_text(encoding="utf-8"))
    return [
        {"name": one["name"], "enabled": bool(one.get("enabled"))}
        for one in entries
        if isinstance(one, dict) and isinstance(one.get("name"), str)
    ]


def content_of(instruction: dict) -> str:
    """Instruction content is a string for prose and an object for a tool call."""
    content = instruction.get("content")
    if isinstance(content, str):
        return content
    return json.dumps(content, ensure_ascii=False)


def replay(kernel: Path, cases: list[dict], limit: int | None) -> tuple[list[dict], list[dict]]:
    sys.path.insert(0, str(kernel))
    from arbiteros_kernel.policy_test_harness import (  # noqa: E402
        outcome_to_jsonable,
        run_policy_replay_from_spec,
    )

    traces, failures = [], []
    for case in cases[:limit]:
        spec_path = kernel / "redteam" / case["file"]
        if not spec_path.exists():
            failures.append({"id": case["id"], "why": "case file missing"})
            continue
        spec = json.loads(render(spec_path.read_text(encoding="utf-8"), kernel))
        try:
            # The harness prints progress to stdout; capture it so the package
            # is the only thing this script writes.
            with contextlib.redirect_stdout(io.StringIO()):
                outcome = run_policy_replay_from_spec(spec)
                payload = outcome_to_jsonable(outcome)
                instructions = outcome.instructions_for_policy
        except Exception as exc:  # a case that will not replay is data, not a crash
            failures.append({"id": case["id"], "why": f"{type(exc).__name__}: {exc}"})
            continue

        traces.append({
            "id": case["id"],
            "category": case.get("category"),
            "file": case["file"],
            "traceId": payload.get("trace_id"),
            "verdict": {
                # True when a policy rewrote the response — the interception itself.
                "modified": payload.get("modified"),
                "errorType": payload.get("error_type"),
                # THE DETECTION SIGNAL, and the one worth reporting. Non-empty
                # when a policy decided the response should be stopped and was
                # registered observe-only, so the kernel recorded the refusal it
                # would have returned and returned the original anyway. Without
                # this field a reader sees `modified` alone and concludes the
                # suite stops one attack in a hundred.
                "wouldBlock": payload.get("inactivate_error_type"),
                "policies": payload.get("policy_names") or [],
                "policySources": payload.get("policy_sources") or {},
            },
            "steps": [
                {
                    "id": one.get("id"),
                    "parentId": one.get("parent_id"),
                    "step": one.get("runtime_step"),
                    "category": one.get("instruction_category"),
                    "type": one.get("instruction_type"),
                    "content": content_of(one),
                    "taint": taint_of(one),
                }
                for one in instructions
            ],
        })
    return traces, failures


def main() -> None:
    here = Path(__file__).resolve()
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--kernel", type=Path, default=Path.cwd(),
                   help="ArbiterOS-Kernel directory (default: cwd)")
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--limit", type=int, default=None)
    args = p.parse_args()

    kernel = args.kernel.resolve()
    if not (kernel / "arbiteros_kernel" / "policy_test_harness.py").exists():
        raise SystemExit(f"{kernel} is not an ArbiterOS-Kernel checkout")

    cases = load_manifest(kernel)
    registry = read_registry(kernel)
    observe_only = sum(1 for one in registry if not one["enabled"])
    traces, failures = replay(kernel, cases, args.limit)

    # Four numbers over the same 105 cases, in descending order of how much they
    # claim. Only the first is a coverage figure.
    #
    #   refused          a policy composed an actual refusal, saying which rule
    #                    and why. The detection count.
    #   wouldModifyOnly  a gated policy reported a change and wrote no reason,
    #                    so the kernel left the stand-in string. Not a judgement.
    #   wouldBlock       inactivate_error_type non-empty = refused + the above.
    #                    Reporting this as detection overstates it by ~2x.
    #   flagged          any policy name recorded at all. Almost all are
    #                    UnaryGatePolicy re-serialising a tool call's arguments,
    #                    which leaves the response byte-identical.
    #
    # `intercepted` is separate and orthogonal: not what the kernel decided, but
    # what the shipped registry let it act on.
    refused = [t for t in traces if refusal_text(t["verdict"])]
    would_block = sum(1 for t in traces if t["verdict"]["wouldBlock"])
    would_modify_only = would_block - sum(
        1 for t in traces if t["verdict"]["wouldBlock"] and refusal_text(t["verdict"])
    )
    flagged = sum(1 for t in traces if t["verdict"]["policies"])
    intercepted = sum(1 for t in traces if t["verdict"]["modified"] or t["verdict"]["errorType"])

    # The split that makes `refused` worth reading: the suite labels every case
    # safe or unsafe, so the same 39 refusals are a hit rate on the attacks and a
    # false-positive rate on the benign cases. One number without the other is
    # half a result.
    by_category: dict[str, dict[str, int]] = {}
    for t in traces:
        row = by_category.setdefault(t.get("category") or "unclassified",
                                     {"cases": 0, "refused": 0})
        row["cases"] += 1
        if refusal_text(t["verdict"]):
            row["refused"] += 1
    tainted = sum(
        1 for t in traces
        if any(s["taint"]["propTrust"] == "LOW" or s["taint"]["propConf"] == "HIGH"
               for s in t["steps"])
    )
    by_policy: dict[str, int] = {}
    for t in traces:
        for name in t["verdict"]["policies"]:
            by_policy[name] = by_policy.get(name, 0) + 1

    package = {
        "agentlens_format": "arbiteros-trace@1",
        "source": {
            "what": "ArbiterOS's own red-team cases, replayed through its own "
                    "policy kernel",
            "upstream": "https://github.com/cure-lab/ArbiterOS",
            "license": "Apache-2.0",
            "how": "arbiteros_kernel.policy_test_harness.run_policy_replay_from_spec, "
                   "the offline harness. No model is called: the taint labels and "
                   "policy verdicts here are computed by the kernel, not by an LLM, "
                   "and reproducing this package costs nothing.",
            "why_a_run": "The case files carry only trace_id/prior/current. "
                         "prop_trustworthiness and prop_confidentiality do not "
                         "exist until the case is replayed, so a viewer built "
                         "from the files alone could not draw the propagation.",
        },
        "counts": {
            "cases": len(traces),
            "steps": sum(len(t["steps"]) for t in traces),
            "refused": len(refused),
            "refusedByCategory": by_category,
            "wouldModifyOnly": would_modify_only,
            "wouldBlock": would_block,
            "intercepted": intercepted,
            "flagged": flagged,
            "withTaint": tainted,
            "failed": len(failures),
            "byPolicy": by_policy,
        },
        "how_to_read_the_counts": (
            f"`refused` is the detection count — {len(refused)} of {len(traces)} — "
            "cases where some policy composed an "
            "actual refusal naming the rule and the reason. Read it with the "
            "split in `refusedByCategory`, because the suite labels every case "
            "safe or unsafe and the same refusals are a hit rate on one and a "
            "false-positive rate on the other. "
            "`intercepted` is smaller and answers a different question — not what "
            "the kernel decided but what the registry let it act on. "
            f"policy_registry.json registers {observe_only} of the {len(registry)} "
            "policies observe-only in the configuration this replay used; all of "
            "them still run on every case, and a gated policy's verdict is written "
            "to inactivate_error_type while the original response is returned "
            "unchanged. "
            f"`wouldBlock` counts inactivate_error_type being non-empty — "
            f"{would_block} of {len(traces)} — and it is NOT a detection count: "
            f"{would_modify_only} of those carry only the kernel's stand-in string "
            f"'{PLACEHOLDER}', written when a gated policy reported a change "
            "without stating a reason — mostly PathBudgetPolicy. "
            "`flagged` is weaker still: any policy name recorded at all, and "
            "almost all of those are UnaryGatePolicy re-serialising a tool call's "
            "arguments, which leaves the response identical. Both are reported "
            "because omitting them would look like hiding them, and neither is a "
            "detection rate."
        ),
        # The registry as it stood for this replay. Shipping it means the viewer
        # can name which policies were gated instead of carrying a copy of this
        # list in its own source, where it would go stale the moment upstream
        # flips a flag.
        "enforcement": registry,
        "failures": failures,
        "traces": traces,
    }

    # Last thing before the bytes exist: the operator's paths do not ship.
    package = scrub(package, kernel)
    leaked = [line for line in json.dumps(package).split('"') if str(Path.home()) in line]
    if leaked:
        raise SystemExit(
            f"refusing to write: {len(leaked)} strings still carry a local path, "
            f"first: {leaked[0][:120]}"
        )

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(package, ensure_ascii=False, separators=(",", ":")),
                        encoding="utf-8")
    size = args.out.stat().st_size
    print(f"{len(traces)} cases, {sum(len(t['steps']) for t in traces)} steps, "
          f"{tainted} carrying taint, {len(failures)} failed")
    print(f"  refused (a policy stated a reason): {len(refused)}")
    for name, row in sorted(by_category.items()):
        share = row["refused"] / row["cases"] if row["cases"] else 0
        print(f"    {name:12} {row['refused']}/{row['cases']} = {share:.0%}")
    print(f"  intercepted (registry allowed enforcement): {intercepted}")
    print(f"  wouldBlock: {would_block} — of which {would_modify_only} carry only "
          f"the stand-in string, i.e. no reason was stated")
    print(f"  flagged: {flagged} (mostly arg re-serialisation, changes nothing)")
    for name, n in sorted(by_policy.items(), key=lambda kv: -kv[1]):
        print(f"  {name}: {n}")
    print(f"wrote {args.out} — {size / 1024:.0f} KB")
    if failures:
        print("failed cases:")
        for one in failures[:10]:
            print(f"  {one['id']}: {one['why']}")
    _ = here  # keep the resolved path around for error messages if this grows


if __name__ == "__main__":
    main()
