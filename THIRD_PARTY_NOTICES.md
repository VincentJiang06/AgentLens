# Third-party notices

AgentLens ships a small amount of data it did not produce, so that the demo opens with
something real instead of invented records. Everything redistributed here is under its
original license, unmodified except where stated.

Two entries are of a second kind and are marked as such. **PromptWise** is code AgentLens
*ran* and does not ship. **ArbiterOS** is now both kinds at once: this repository redistributes
their case files, and it also ships numbers their own kernel computed from those cases when we
ran it. Nothing of either project is vendored — no source file of theirs is copied into this
repository — and a package built from a run of ours contains only what that run produced. They
are listed because attribution is owed for that too.

| Third party | What is in this repository | License |
| --- | --- | --- |
| RM-R1 | a sample of their evaluation logs, plus complete outcome tables | Apache-2.0 |
| ArbiterOS | their 105 red-team cases, concatenated — and, separately, what their kernel computed from those same cases in a run of ours | Apache-2.0 |
| PromptWise | no code and no data — only numbers our run of their algorithms produced | MIT |

## RM-R1 evaluation logs

`public/demo-data/rm-r1/rm-r1-32b.json` and `public/demo-data/rm-r1/rm-r1-compare.json`
are built from the released evaluation logs under `eval/result/` in:

- **Project**: RM-R1 — https://github.com/RM-R1-UIUC/RM-R1
- **License**: Apache License 2.0 — http://www.apache.org/licenses/LICENSE-2.0
- **Source revision**: `d4c2542f0608e019074b9b2322fe6502e6ab7ab0` (2025-06-25)
- **Runs used**: `RM-R1-Qwen2.5-Instruct-32B` (both packages) and
  `RM-R1-DeepSeek-Distilled-Qwen-32B` (the compare package)

**Changes made.** Four, all declared inside the packages themselves under `sampling`,
`coverage` and `notes`, and all made by
[`scripts/build-demo-data/rm-r1.mjs`](scripts/build-demo-data/rm-r1.mjs), which is in this
repository:

1. **Sampled.** The logs are ~130 MB. `rm-r1-32b.json` carries the full text of 232 of the
   2,985 RewardBench records and 30 of the 1,327 RM-Bench ids across all three style
   files, plus three of the four released RMB logs whole (they are 2 records each);
   `rm-r1-compare.json` carries the same 40 RewardBench source indices from each of the
   two runs. Selection is stratified systematic sampling — fixed strides through the source
   file's own order, no RNG and no seed — and it over-represents the judgements the model
   got wrong. Each record is the source object **verbatim**.
2. **One record truncated.** `reward_bench` index 308, in `rm-r1-32b.json` only, has its
   `answers` field cut from the middle (44,259 → 18,118 bytes) with a sentence in the gap,
   and carries `agentlens_truncated` naming the field that was cut. It is the only
   truncation in either package: `rm-r1-32b.json`'s `bundle.credit` declares it and
   `rm-r1-compare.json`'s says its records are verbatim, and `sampling.truncated` in each
   package lists every cut with its byte counts and the record it happened to.
3. **Score files redacted.** The drop of `model`, `model_type` and `chat_template` is
   applied to every score file (eight in `rm-r1-32b.json`, two per run in
   `rm-r1-compare.json`), and each file records under `dropped_keys` what was actually
   dropped from it — in these releases only `each_small_section_score.json` carries those
   three keys. Its `model` names an internal training checkpoint which spells out a
   training-data recipe; that is not ours to redistribute, and the build fails rather than
   write it. No other field of any score file is altered.
4. **Two records withheld, and three files left out mechanically.** The
   `RMB/BoN_set_Harmlessness` pair — 2 records — is excluded because the rejected response
   *is* the demeaning content the item tests refusal of; the file it came from and the
   reason are in `sampling.withheld`. Three further files of that run are absent for
   mechanical reasons and are listed with those reasons in `sampling.excluded`: the
   regrouped copy of the same withheld pair, `RMB/BoN_set_Helpfulness/log_result/`
   `group_by_same_id_logs.json` (not valid JSON in the release), and
   `RM-Bench/logs/final_result.json` (a byte-identical duplicate of a file that is packed).
   The build walks the run's released directory and fails if any file is in neither the
   package nor one of those two lists, so nothing is omitted silently.

Alongside the sample, each package carries the **complete outcome table** for every run in
it: `source_index`, `id`, group and correct/incorrect for every record in the source file,
plus the harness's A/B shuffle flag on RewardBench and all three style files' result triples
on RM-Bench, and none of the text. Every figure AgentLens shows under a benchmark's own
name — per-subset accuracy, the four RewardBench sections, the RM-Bench 3×3 style matrix and
its four metrics, and in the two-run package the run-to-run agreement matrix and the
per-group movement beside it — is computed from those tables, over the whole benchmark, and
in the two-run package each such figure names the run it belongs to. The build checks that
the tables support this rather than asserting it: it recomputes RM-R1's own released score
files from the packed tables, and the two-run agreement matrix from the two packed tables
joined on `source_index`, and refuses to write a package that does not reproduce them.
Figures that need the judge's text, and so can only be the sample's — the judgement browser
and its counts, the sample's own accuracy, anything read out of a Chain-of-Rubrics trace,
and the two-run package's A/B position note, whose shuffle flag is in the table but whose
`[[A]]`/`[[B]]` letters are only in the text — are listed as the sample's in each package's
`coverage` block, which names every figure the demo shows with the denominator it is over.

**Why it is here.** These are the logs behind RM-R1's published numbers, in a public
Apache-2.0 repository, and they are what makes the adapter show a real reward model's
real reasoning instead of a mock-up. If the RM-R1 maintainers would prefer this copy not
be redistributed, it will be removed on request — open an issue and it goes.

## ArbiterOS

Two packages, from one project, and they are owed different sentences. One redistributes
ArbiterOS's files. The other redistributes nothing of theirs and holds numbers their own
kernel computed. Both are covered by the same attribution:

- **Project**: ArbiterOS — https://github.com/cure-lab/ArbiterOS
- **Copyright**: Copyright 2026 cure-lab
- **License**: Apache License 2.0 — http://www.apache.org/licenses/LICENSE-2.0
- **Source revision**: `78a8f98b1f1b4fdd2d875a058f52896cb588f8cf` (2026-06-01) — the revision
  the cases were copied from, and the revision of the kernel that computed the numbers

### The red-team cases

`public/demo-data/arbiteros-preview/cases.json` is a repackaging of the 105 red-team case
files under `ArbiterOS-Kernel/redteam/case/`.

**Changes made.** The individual case files were concatenated into a single JSON array so
the viewer can fetch one file instead of 105. No field was added, removed or edited: each
entry is the source file's object verbatim (`trace_id`, `prior`, `current`), and no case
was filtered out or synthesised.

**Why it is here.** These cases are the adversarial scenarios ArbiterOS's own test harness
runs, and they are what makes the preview adapter show real agent behaviour rather than a
lorem-ipsum list. They are published in a public Apache-2.0 repository.

### The replay — run, not vendored

`public/demo-data/arbiteros/traces.json` contains **no ArbiterOS source code.** It holds what
their kernel computed: [`scripts/arbiteros-runner/run.py`](scripts/arbiteros-runner/run.py)
imports `arbiteros_kernel.policy_test_harness` from a checkout **you** supply, replays each of
the 105 cases through the real `InstructionBuilder` and the real policy chain, and writes down
the instructions and verdicts that came back. No model is called and nothing is invented: every
security label, every propagated label and every policy verdict in that file was produced by
ArbiterOS's code, on ArbiterOS's cases, under ArbiterOS's shipped default configuration.

**Nothing is vendored.** No file from that repository is copied into this one. `run.py` checks
for `arbiteros_kernel/policy_test_harness.py` under `--kernel` and exits with the reason if it
is not there, so the code being credited here is code the reader has to fetch themselves.

**What is derived from their files.** The cases are the input, so the package carries their
content: each case's `id`, its path within their repository, and each step's `content` — a
message's prose or a tool call's JSON — appear as they arrived. Three mechanical edits are made
and all three are described in
[`scripts/arbiteros-runner/README.md`](scripts/arbiteros-runner/README.md):

1. the eight path substitutions the upstream batch runner itself applies before every case,
   which rewrite the cases' hardcoded `/root/...` onto the machine the replay runs on — several
   policies match on where a file lives, and without this almost nothing fires;
2. the reverse of that substitution, applied to every string of the finished structure before it
   is written, so the paths of whoever ran the replay leave no trace in the published package:
   they are replaced by `<redteam>`, `<arbiteros-kernel>` and `<openclaw-home>`, and the runner
   refuses to write the file at all if a home-directory path survives;
3. the reduction of each instruction's much larger record down to the seven `security_type`
   fields a propagation graph needs.

No verdict, label or count is edited, recomputed or rounded.

**Why it is here.** The taint labels exist in no file on disk — they are what the kernel
computes when a case is replayed — so a viewer of ArbiterOS traces cannot be demonstrated
without a run, and a run of their kernel is the only honest way to get one.

If the ArbiterOS maintainers would prefer either of these not be redistributed, it will be
removed on request — open an issue and it goes.

The Apache License 2.0 requires that redistributions carry the above attribution and a copy
of the license; the copy is `LICENSE-APACHE-2.0.txt`, beside this file. Both travel with the
repository, and anything that redistributes `public/demo-data/` — a deployed build of the
site included — has to carry them with it.

## PromptWise — run, not vendored

`public/demo-data/promptwise/uniform.json` and `public/demo-data/promptwise/tiered.json`
contain **no PromptWise code and no PromptWise data.** They hold numbers our own run
produced: [`scripts/promptwise-runner/run.py`](scripts/promptwise-runner/run.py) imports
the learner classes and the environment from a checkout **you** supply, drives them over a
synthetic setup, and writes down what they decided.

- **Project**: PromptWise — https://github.com/yannxiaoyanhu/PromptWise
- **Paper**: *PromptWise: Online Learning for Cost-Aware Prompt Assignment in Generative
  Models* — Xiaoyan Hu, Lauren Pick, Ho-fung Leung and Farzan Farnia,
  [arXiv:2505.18901](https://arxiv.org/abs/2505.18901)
- **License**: MIT — Copyright (c) 2025 Xiaoyan Hu (`LICENSE` in that repository)
- **Revision run**: `930df43ba471bac3a977771020268f2587e2ff9b` (`main`, 2025-11-01), plus two
  local three-line changes for NumPy ≥ 1.25 compatibility. Those changes are **ours and are
  not upstream**; what they are and why two of the eight learners need them is in
  [`scripts/promptwise-runner/README.md`](scripts/promptwise-runner/README.md).

**Nothing is vendored.** No file from that repository is copied into this one. `run.py` takes
`--promptwise <path>` and exits with the reason if the path is not a checkout, so the code
being credited here is code the reader has to fetch themselves. The MIT license's condition
attaches to copies and substantial portions of the software, and AgentLens redistributes
neither; this notice is here because those numbers would not exist without their algorithms,
and attribution is owed whether or not a license compels it.

**What the numbers are.** Synthetic, and every package says so on its own face: random
embeddings stand in for prompts, a generated table stands in for whether a model can solve
one, and `MODEL_A`…`MODEL_E` are upstream's placeholder names rather than real models. No
figure from the paper is reproduced, and no number is any model's real accuracy. Each package
states this in its own `source.data`, and the adapter renders that sentence rather than
composing its own. The one methodological departure from upstream's `test.py` — the prompt
stream is drawn once and replayed through every learner, so the comparison is over the same
tasks — is recorded in each package under `source.departure` and argued in the runner's
README.

**Why it is here.** PromptWise open-sources the algorithms but not the experiment pipeline:
`utils/aux.py` defines `save_stats` and nothing calls it, so the curves are never written to
a file and the per-decision detail never exists outside one loop iteration. That gap is what
the M2 adapter fills, and filling it honestly means saying whose algorithms produced the
numbers. If the PromptWise authors would prefer these packages not be published, they will be
removed on request — open an issue and they go.
