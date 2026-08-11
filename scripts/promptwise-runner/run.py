#!/usr/bin/env python3
"""Run PromptWise's own learners and record what they decided, step by step.

PromptWise (Hu, Pick, Leung, Farnia) open-sources the algorithms but not the
experiment pipeline: `utils/aux.py` defines `save_stats`, nothing ever calls it,
and there is no plotting code. So the numbers exist only as a line printed every
hundred steps, and the per-decision detail — which model was tried, what it cost,
what the router believed at that moment — is never written down at all.

This runner drives the upstream classes unmodified and writes both: the curves
`save_stats` would have produced, and the decision trace underneath them. Output
is `promptwise@1`, which the AgentLens promptwise adapter renders.

    python scripts/promptwise-runner/run.py --promptwise ../PromptWise \
        --out public/demo-data/promptwise/synthetic.json

Requires that checkout's `fix/numpy2-compat` branch: on `main`, `promptwise` and
`ca-pak-ucb-tS` raise under NumPy >= 1.25 and cannot be run at all.

── One deliberate departure from test.py, and why ────────────────────────────
`test.py` draws its prompt with `np.random.randint(n_data)` inside the loop, from
the same global RNG the learners draw from. Learners consume randomness at
different rates: a till-succeed learner makes a variable number of reward draws
per step depending on how many models it tries, and each learner's own arm
selection draws too. So by step two the shared RNG has advanced by a different
amount for each of them, every learner sees a *different* sequence of prompts,
and the curves being compared are not over the same tasks. This runner draws the
whole prompt stream up front and replays that one stream through every learner,
which is what makes the comparison a comparison. Everything else is theirs.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

# The five models test.py ships, with its prices. Kept verbatim: changing them
# would make these curves incomparable with anything the authors ran.
MODEL_SET = ["MODEL_A", "MODEL_B", "MODEL_C", "MODEL_D", "MODEL_E"]
MODEL_COST = [12.50, 0.75, 10.00, 1.37, 1.60]

ALL_LEARNERS = [
    "promptwise",
    "ca-pak-ucb-tS",
    "greedy",
    "GtS",
    "random",
    "RtS",
    "lowest-cost",
    "highest-cost",
]


def load_upstream(root: Path):
    """Import the upstream package from a checkout we do not vendor."""
    if not (root / "algorithms" / "aux.py").exists():
        raise SystemExit(
            f"{root} does not look like a PromptWise checkout "
            "(no algorithms/aux.py). Pass --promptwise <path>."
        )
    sys.path.insert(0, str(root))
    from algorithms.aux import LEARNER  # noqa: E402
    from utils.aux import cost_aware_env  # noqa: E402

    return LEARNER, cost_aware_env


def run_learner(name, LEARNER, cost_aware_env, *, prompt_stream, prompt_reps,
                model_result_array, args):
    """One learner over the shared prompt stream. Returns curves + a decision trace."""
    G = len(MODEL_SET)
    T, epochs = args.steps, args.epochs

    env = cost_aware_env(
        G=G, task="synthetic", T=T, num_epoch=epochs, model_set=MODEL_SET,
        model_cost=MODEL_COST, rd_budget=args.rd_budget, cost_para=args.cost_para,
        model_result_array=model_result_array,
    )

    steps = []
    for epoch in range(epochs):
        # Every learner starts from the same seed, so a learner's own draws
        # cannot shift the prompt stream (which is fixed) but its internal
        # tie-breaks stay reproducible run to run.
        np.random.seed(args.seed + epoch)
        learner = LEARNER[name](
            G=G, T=T, num_dim=args.dim, kernel_method=args.kernel_method,
            krr_alpha=1.0, kernel_para_c=1.0, kernel_para_d=3.0,
            kernel_para_gamma=5.0, cost_para=args.cost_para,
            rd_budget=args.rd_budget, model_cost=MODEL_COST, exp_para=args.exp_para,
            exp_eta=1.0, tau_exp=args.tau_exp, reg_method=args.reg_method,
        )

        for t in range(T):
            env.reset_within_step_stats()
            id_t = int(prompt_stream[epoch][t])
            env.get_reference_value(id_t)
            context_t = prompt_reps[id_t].reshape(1, -1)

            rounds = []
            skip = False
            while not skip:
                arm = learner.select_arm(context=context_t)
                # `rd_ucb_q` is the optimistic success estimate the router just
                # acted on, and `rd_ucb_u` the utility it maximised. They are the
                # only record of *why* this arm and not another, and they are
                # gone by the next step — so they are read here or never.
                beliefs = None
                q = getattr(learner, "rd_ucb_q", None)
                u = getattr(learner, "rd_ucb_u", None)
                if q is not None and u is not None:
                    beliefs = {
                        "ucb_q": [round(float(x), 5) for x in np.ravel(q)],
                        "utility": [round(float(x), 5) for x in np.ravel(u)],
                    }

                reward = env.get_reward(selected_model=arm, id_t=id_t)
                skip = learner.rd_skip
                learner.update_stats(g=arm, context=context_t, reward=reward)
                env.update_env_stats(selected_model=arm, reward=reward)

                if arm is not None:
                    entry = {
                        "arm": MODEL_SET[arm],
                        "cost": MODEL_COST[arm],
                        "reward": int(reward) if reward is not None else None,
                    }
                    if beliefs:
                        entry["beliefs"] = beliefs
                    rounds.append(entry)

            env.update_entire_process_stats(t=t)

            if epoch == 0 and rounds:
                outcome = (
                    "success" if any(r["reward"] == 1 for r in rounds)
                    else "budget_exhausted" if len(rounds) >= args.rd_budget
                    else "gave_up"
                )
                steps.append({
                    "t": t,
                    "prompt_id": id_t,
                    "rounds": rounds,
                    "outcome": outcome,
                    # An escalation is the paper's whole claim made concrete:
                    # a cheap model tried first, and a dearer one only after.
                    "escalated": len(rounds) > 1
                    and rounds[-1]["cost"] > rounds[0]["cost"],
                })

    # test.py's own normalisation, from `save_stats`: these arrays accumulate
    # across both steps and epochs.
    denom = np.arange(1, T + 1) * epochs
    curves = {
        "t": list(range(1, T + 1)),
        "utility": np.round(env.alg_v / denom, 5).tolist(),
        "cost": np.round(env.total_cost / denom, 5).tolist(),
        "success": np.round(env.cumulative_reward / denom, 5).tolist(),
        "opr": np.round(env.opr / denom, 5).tolist(),
    }
    visitation = (env.pick_ratio[-1] / denom[-1]).tolist()

    return {
        "learner": name,
        "curves": curves,
        "visitation": {m: round(float(v), 5) for m, v in zip(MODEL_SET, visitation)},
        "final": {k: v[-1] for k, v in curves.items() if k != "t"},
        "oracle_utility": round(float(env.ref_v[-1] / denom[-1]), 5),
        "steps": steps,
    }


def thin(steps, keep_first, every):
    """Keep the opening, a regular sample after it, and every escalation.

    Escalations are never dropped: they are the behaviour the viewer exists to
    show, and sampling them away would flatter nothing but the file size.
    """
    kept = []
    for step in steps:
        if step["t"] < keep_first or step["t"] % every == 0 or step["escalated"]:
            kept.append(step)
    return kept


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--promptwise", type=Path, required=True,
                   help="path to a PromptWise checkout on fix/numpy2-compat")
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--learners", nargs="*", default=ALL_LEARNERS)
    p.add_argument("--steps", type=int, default=1000)
    p.add_argument("--epochs", type=int, default=20)
    p.add_argument("--seed", type=int, default=1234)
    p.add_argument("--dim", type=int, default=768)
    p.add_argument("--n-data", type=int, default=164)
    p.add_argument("--cost-para", type=float, default=0.05)
    p.add_argument("--rd-budget", type=int, default=5)
    p.add_argument("--tau-exp", type=int, default=1)
    p.add_argument("--exp-para", type=float, default=None)
    p.add_argument("--kernel-method", default="rbf")
    p.add_argument("--reg-method", default="klr")
    p.add_argument("--keep-first", type=int, default=50)
    p.add_argument("--sample-every", type=int, default=20)
    p.add_argument(
        "--tiers", nargs=5, type=float, metavar=("A", "B", "C", "D", "E"), default=None,
        help="per-model success probability, in MODEL_SET order. Omit to use "
             "test.py's own table, where every model succeeds ~50%% of the time.",
    )
    args = p.parse_args()

    LEARNER, cost_aware_env = load_upstream(args.promptwise.resolve())

    # The shared world: prompt embeddings, the per-model success table, and the
    # prompt order. Drawn once, before any learner exists, so no learner's own
    # sampling can perturb what the next one sees.
    np.random.seed(args.seed)
    prompt_reps = np.random.randn(args.n_data, args.dim)
    shape = (len(MODEL_SET), args.n_data, 10)
    if args.tiers:
        # `randint(2, …)` gives every model the same ~50% success rate, so no
        # model is worth escalating TO and the router correctly settles on the
        # cheapest and retries it. The paper's mechanism — try cheap, escalate
        # when it fails — can only appear when the models actually differ, so
        # this draws the table from a per-model success probability instead.
        # The probabilities are a choice of ours and the package says so.
        probs = np.array(args.tiers).reshape(-1, 1, 1)
        model_result_array = (np.random.rand(*shape) < probs).astype(int)
    else:
        model_result_array = np.random.randint(2, size=shape)
    prompt_stream = np.random.randint(args.n_data, size=(args.epochs, args.steps))

    runs = []
    for name in args.learners:
        print(f"  {name} …", flush=True)
        run = run_learner(name, LEARNER, cost_aware_env,
                          prompt_stream=prompt_stream, prompt_reps=prompt_reps,
                          model_result_array=model_result_array, args=args)
        before = len(run["steps"])
        run["steps"] = thin(run["steps"], args.keep_first, args.sample_every)
        print(f"    final utility {run['final']['utility']:.4f} "
              f"cost {run['final']['cost']:.3f} success {run['final']['success']:.4f} "
              f"| trace {len(run['steps'])}/{before} steps", flush=True)
        runs.append(run)

    package = {
        "agentlens_format": "promptwise@1",
        "source": {
            "what": "PromptWise's own learners on its own synthetic setup",
            "upstream": "https://github.com/yannxiaoyanhu/PromptWise",
            "branch": "fix/numpy2-compat",
            "data": (
                "SYNTHETIC — random embeddings, and a success table drawn from "
                "the per-model probabilities in config.success_rates, which are "
                "ours. These curves describe algorithm behaviour on invented "
                "data, not any model's real accuracy, and no number here "
                "reproduces a figure from the paper."
                if args.tiers else
                "SYNTHETIC — random embeddings and a random success table, "
                "exactly as the upstream test.py generates them: every model "
                "succeeds about half the time. These curves describe algorithm "
                "behaviour, not any model's real accuracy, and no number here "
                "reproduces a figure from the paper."
            ),
            "note": (
                "Because every model here is equally likely to succeed, no model "
                "is worth escalating to: the router settles on the cheapest and "
                "retries it, which is the correct answer to this world. The "
                "tiered package is the one that shows escalation."
                if not args.tiers else
                "Models differ in competence here, which is what makes 'try the "
                "cheap one, escalate when it fails' visible at all."
            ),
            "departure": "One: the prompt stream is drawn once and replayed "
                         "through every learner, so all of them see the same "
                         "tasks. test.py draws it from the same RNG the learners "
                         "use, which gives each learner a different stream.",
        },
        "config": {
            "models": [{"name": m, "cost": c} for m, c in zip(MODEL_SET, MODEL_COST)],
            "steps": args.steps, "epochs": args.epochs, "seed": args.seed,
            "cost_para": args.cost_para, "rd_budget": args.rd_budget,
            "tau_exp": args.tau_exp, "reg_method": args.reg_method,
            "kernel_method": args.kernel_method, "n_data": args.n_data, "dim": args.dim,
            "success_rates": (
                {m: r for m, r in zip(MODEL_SET, args.tiers)} if args.tiers
                else "uniform (test.py's randint table)"
            ),
        },
        "trace_sampling": {
            "epoch": "epoch 0 only; the curves are over all epochs",
            "rule": f"every step below t={args.keep_first}, then every "
                    f"{args.sample_every}th, plus every escalation",
        },
        "runs": runs,
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(package, separators=(",", ":")), encoding="utf-8")
    size = args.out.stat().st_size
    print(f"\nwrote {args.out} — {size / 1024:.0f} KB, {len(runs)} learners")
    if size > 2 * 1024 * 1024:
        print("  note: over the 2 MB budget; raise --sample-every or lower --steps")


if __name__ == "__main__":
    main()
