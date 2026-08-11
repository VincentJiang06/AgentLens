# AgentLens

**English** · [中文](README.zh-CN.md)

A local-first viewer for LLM and agent research artifacts — evaluation logs, agent
traces, memory stores, router decisions.

Research code emits a lot of JSON that nobody enjoys reading. The usual options are
scrolling a 22 MB file in an editor, writing another one-off notebook, or uploading it
to somebody's server. AgentLens is the fourth option: open a static web page, drop the
file in, and look at it.

> **All data stays in your browser — nothing is uploaded.**

---

## Status

**M0 — the shell.** Drag-and-drop, format sniffing, fault-tolerant parsing, virtualised
rendering, deep links and deployment are the deliverable.

**M1 — the RM-R1 adapter.** `rm-r1` reads all four log families RM-R1's harness writes
(RewardBench, RM-Bench, RMB pairwise, RMB best-of-n) plus the score files beside them,
and shows three views: every judgement with its rubric, its evidence spans and its
verdict; the benchmark scores recomputed from the run's own outcomes; and two runs
against each other. Two demo packages open it — one run, and two checkpoints to compare.

**M2 — the PromptWise adapter.** `promptwise` reads a run of PromptWise's cost-aware router
and shows three views. The four learning curves — utility, cost, success and optimal-pick rate
against *t* — with every learner as a line and the oracle drawn as a ceiling rather than a
competitor. The cost/success plane, one labelled point per learner, sized to survive being
pasted into an email and carrying its own caption for when it is. And a replay of the
decisions: one prompt per row, the chain of calls it took in order, and for any call the
router had an estimate for, what it believed about all five models at the moment it chose —
with the identity `utility = 1 − cost_para × cost / q` recomputed from the package's own
numbers rather than asserted. That chain is the escalation the paper is about: a cheap model
tried first, a dearer one only after it failed.

PromptWise open-sources the algorithms and not the experiment pipeline — `utils/aux.py`
defines `save_stats` and nothing calls it — so there was no log format to adapt to. The
packages are produced by [`scripts/promptwise-runner/run.py`](scripts/promptwise-runner/README.md),
which drives their classes unmodified from a checkout you supply and writes down both the
curves that were never saved and the decisions that were never recorded at all.

**M3 — the ArbiterOS adapter.** `arbiteros` reads a replay of ArbiterOS's red-team suite
through ArbiterOS's own policy kernel — 105 cases, 500 instructions — and shows what the
kernel computed for each: every instruction with the security labels it was given, the
propagation along the `reference_tool_id` chain (trust takes the minimum seen,
confidentiality the maximum), and, where a step's propagated label differs from the label it
declares for itself, which ancestor moved it. Naming that ancestor is the whole point of
drawing the chain: all 500 steps carry labels, but only 26 carry one that some earlier step
is responsible for. Beside it, what the policy chain concluded on that case, and a pointer
into the kernel's own source for each policy that appears in the verdict.

The labels are the reason the adapter needs a replay rather than the case files. A case on
disk is `trace_id`, `prior` and `current` — an attack script, and nothing about taint.
`prop_trustworthiness` and `prop_confidentiality` are not in any file; they exist only once
the kernel has replayed the case. [`scripts/arbiteros-runner/run.py`](scripts/arbiteros-runner/README.md)
is that replay, and it calls no model: no API key, no gateway, no tokens, no cost. That is
measured rather than assumed, and how is in the runner's README.

`arbiteros-preview` stays, and is not superseded by it. It reads the raw case files and lists
them, one line per case, which is a different artifact from the replay rather than a subset of
one: a case is the attack as its author wrote it, before any kernel has touched it. Keeping it
also keeps every `?demo=arbiteros-preview` link that has already been mailed working, and it
remains the smallest worked example of the shell/adapter seam — a registered adapter that
sniffs its own data, builds its own model, and renders its own view instead of the fallback,
which is what [Writing an adapter](#writing-an-adapter) points at.

Everything else still falls back. Drop a RecMem log today and you get the generic record
browser with a collapsible JSON tree, because that adapter does not exist yet. See
[Roadmap](#roadmap).

### Where the demo data comes from

**The RM-R1 and ArbiterOS demos are real data; the two PromptWise packages are synthetic, and
they are the only ones that are.** Both facts are on screen: a demo credits its source
whenever it is open, and the PromptWise packages carry the synthetic warning in their own
provenance block, in the runner's words, rendered rather than paraphrased.

The RM-R1 packages under
`public/demo-data/rm-r1/` are built from the released
[RM-R1-UIUC/RM-R1](https://github.com/RM-R1-UIUC/RM-R1) evaluation logs (Apache-2.0) by
[`scripts/build-demo-data/rm-r1.mjs`](scripts/build-demo-data/rm-r1.mjs), which is in the
repository so the sampling can be argued with rather than taken on trust: each record is the
source object verbatim apart from a single declared truncation, the sample rule is written
into the package, and the truncated record says so on its own face.

There are two ArbiterOS packages, from
[cure-lab/ArbiterOS](https://github.com/cure-lab/ArbiterOS) (Apache-2.0, revision `78a8f98`),
and they are different kinds of thing. The preview demo is their 105 red-team cases,
concatenated into one JSON array and otherwise untouched — their files. The M3 demo contains
no file of theirs: it is what their kernel computed from those cases when we replayed them,
labels and verdicts alike, produced by
[`scripts/arbiteros-runner/run.py`](scripts/arbiteros-runner/README.md) against a checkout you
supply. No ArbiterOS code is vendored here either way. Attribution, the license, and the exact
changes made are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); the app credits the
source on screen whenever either demo is open. If the ArbiterOS maintainers would rather
either not be redistributed, open an issue and it will be removed.

Real data is a deliberate choice — a viewer demonstrated on invented records proves
nothing about whether it can read yours — but it comes with the obligation to say whose
data it is, every time.

The PromptWise packages under `public/demo-data/promptwise/` are the exception, and the
exception has a reason: what an online router does is a property of the algorithm and the
prices, not of any dataset, and PromptWise's own `test.py` demonstrates it on generated data
for exactly that reason. So the prompts are random 768-dimensional vectors, whether a model
solves one is a generated coin flip, and `MODEL_A`…`MODEL_E` are upstream's placeholder
names, kept verbatim because renaming them to real vendors would invent a claim. **No number
in either package is any model's real accuracy and none reproduces a figure from the paper**
— the packages say that themselves, and the adapter puts the sentence above the first chart
rather than in a footnote. Two packages ship because the pair is the finding: on upstream's
own success table every model is equally good, so the router correctly settles on the
cheapest and retries it, and escalation only appears once the models differ. That argument,
with the measured numbers and the one place the runner departs from `test.py`, is in
[`scripts/promptwise-runner/README.md`](scripts/promptwise-runner/README.md).

### What the numbers on screen are over

A demo package is sampled, so the numbers it shows have to be careful about their
denominator. The rule the packages and the adapter both hold to: **a figure computed over
the sample never wears a benchmark's name.**

That is affordable because a package is in two halves. The full text of a judgement — the
prompt, both responses, the Chain-of-Rubrics trace — is sampled, and everything read out
of it is the sample's: the browser's list, its counts and filters, its own accuracy. But
the *outcome* of every record in the source file (position, `id`, subset or domain,
whether the judge got it right, plus RewardBench's A/B shuffle flag and RM-Bench's three
style results) is packed complete and never sampled. That costs 102 KB for RewardBench's
2,985 rows and 72 KB for RM-Bench's 1,327, and it is what the leaderboard-named figures
are computed from: RewardBench accuracy per subset and the four sections, the RM-Bench
3×3 style matrix with `hard_acc` / `normal_acc` / `easy_acc` / `total_avg_acc`, and — in the
two-checkpoint package — the run-to-run agreement matrix and the per-group movement beside
it, joined on source position over all 2,985 items rather than over the 40 whose text
travels. On the shipped 32B package those reproduce the run's own
released score files to the last digit — 92.93% overall over all 2,985 records, where the
sample alone would read 65.52%, because the sample over-represents mistakes on purpose.

One figure in the compare view stays the sample's and says so where it is drawn: the A/B
position note. The shuffle flag is in the table, but the `[[A]]`/`[[B]]` letters it has to
be read against are only in the text, so that count is over the records whose text travels.

Two consequences worth naming. Published scores are keyed **by run**: with two checkpoints
loaded, each score file stays beside the run it belongs to, nothing is merged, and a figure
that cannot say whose it is is not shown. And a package with no complete outcome table —
your own dropped log, for instance — gets the loaded records' own accuracy, labelled as
such, with no section tiles and no delta against anyone's published number.

The full argument, including what the build checks and what it refuses to write, is in
[`scripts/build-demo-data/README.md`](scripts/build-demo-data/README.md).

The PromptWise packages are split the same way, along a different seam. Every curve and every
final figure is over the whole run — 20 epochs × 1,000 prompts per learner, normalised the way
PromptWise's own `save_stats` normalises them. The decision trace beneath the curves is
**epoch 0 only and sampled**, by a rule the package states in its own `trace_sampling` block:
the opening 50 steps, then every 20th, plus every escalation without exception. Keeping all of
them is what lets an escalation count be that epoch's complete count while the steps around it
are a sample — the two are different claims and are not run together. One methodological point
sits under all of it: every learner is replayed over the same prompt stream, which upstream's
`test.py` does not do, so learner-against-learner is a comparison over the same tasks.

The ArbiterOS package is not sampled — all 105 cases, all 500 instructions — so its problem is
not a denominator but a number that reads as its opposite, and it is the first number the
author of a red-team suite would look at. `intercepted` is 1: of the 105 cases, the kernel
rewrote exactly one response, `openclaw_p9_process_poll_loop`, stopped by `RateLimitPolicy` on
a per-tool budget. `flagged` is 66, and the package's own sentence describes that as the number
of cases that tripped a policy. Measured, it is not. 65 of the 66 are `UnaryGatePolicy`
re-serialising a tool call's arguments with the keys in a different order, with no rule matched
and nothing removed — checked over all 105 rather than sampled: parse each `arguments` string
back into JSON and the response the chain was handed compares equal to the response it returned
in every one. **Neither number is the suite's detection rate and neither should be read as
one.**

What the run does say about detection is measured in
[`scripts/arbiteros-runner/README.md`](scripts/arbiteros-runner/README.md), with the per-policy
table under it. All fifteen registered policies run on every case; `enabled` in
`policy_registry.json` decides only what happens when one fires, and four of the fifteen enforce
in the shipped default. Recording each policy's own verdict before that gate, 39 of the 105
cases produce a refusal — 21 of the 45 the suite labels unsafe, 18 of the 60 it labels safe —
and in 38 of the 39 every such policy is observe-only, so the refusal is computed and then
discarded. Those 38 are not in this package: the kernel hands them back in
`inactivate_error_type` and the runner does not record that field yet. So what this package
supports today is a statement about what the shipped configuration *enforced*, not about what
the suite *detects*, and the two are far apart.

## The privacy property, precisely

This is a static site. There is no backend, no database, no account, no telemetry, and
no analytics of any kind.

- Your files are read through the browser's `File` API and parsed inside a Web Worker.
  They never leave the tab. There is no upload endpoint to send them to.
- The only network traffic is loading the page itself, and — if you open one of the
  bundled demo packages — fetching that demo file from the same static site.
- You can verify this rather than trust it: open DevTools → Network and work normally.
  Nothing goes out. Or read the source; there is no `fetch` to a third party in it.

That property is the point of the design, not a footnote. Evaluation logs contain
prompts, model outputs, and sometimes unreleased data. A tool that requires you to
upload those is a tool you cannot use on real work.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173/
```

```bash
npm run build      # type-check + bundle to dist/
npm run preview    # serve dist/ at the production base path
npm run lint
npm test           # node --test over the pure parse and adapter cores
```

Building needs Node 20.19+ or 22.12+ (CI builds on 24). `npm test` runs the TypeScript
test files directly through Node's built-in type stripping, which needs Node 22.18+ or
23.6+ — there is no test bundler or transform step. Developed on Node 24. No other setup
— no API keys, no services.

## What the shell does

**Drop anything.** Multiple files or a whole folder. JSON arrays, JSON objects, JSONL.

**Parse without giving up.** Parsing runs entirely in a Web Worker and streams batches
back, so a 22 MB array does not freeze the tab. Real research logs are frequently not
valid JSON, so a strict parse failure is not the end of the road: the parser falls back
to salvage mode and recovers the records it can, reporting how many segments it had to
skip. A file that only partly parsed is *labelled* as salvaged — a partially recovered
file is not the same claim as a cleanly parsed one, and the UI never quietly blurs the
two.

**Never white-screen.** If no adapter recognises the data — or an adapter throws in
`parse()` or in `render` — the records still render in the raw record browser, with the
reason on screen. Falling back is a normal outcome, not an error state.

**Read it in English or Chinese.** A toggle in the top bar switches AgentLens's own words;
the choice persists, and the browser's language decides the default. Data is never
translated — subset names, domains, file names, format ids and every word the judged model
or the judge wrote render exactly as they arrived. Translating somebody's log would
misquote it, which is the opposite of what a viewer is for. The boundary is stated and
enforced in [`src/shell/lang.ts`](src/shell/lang.ts): the type AgentLens's own phrases
travel in carries both languages and cannot be constructed with one, so a half-translated
phrase is a compile error rather than a surprise on screen. The demo packages are held to
the same rule from the other side: their notes are where the sampling disclosure lands, so
the builder writes each one in both languages and refuses to publish a package where a side
is missing.

**Link to exactly what you mean.** `?demo=<demo-id>&record=<record-id>` preloads a demo
package and selects one record, so a link in an email lands on the specific case you
wanted to show, not on a homepage:

```
<your-pages-url>/?demo=arbiteros-preview&record=cases.json:57
```

Record ids are `<file-name>:<index>`, with a third segment on RM-Bench, where one record is
three judgements — one per style file. A bare index is also accepted **when a single file
is loaded**, so a hand-shortened link still lands; with two files loaded the same index
names two different records, so the link is reported as a miss rather than guessed at. The
`arbiteros-preview` adapter additionally accepts a case's own `trace_id`, which is what the
case is called upstream. `arbiteros` does not use file positions at all: a record is a case,
named by the case id the manifest gives it, and `<case-id>:<step-index>` names one instruction
inside it — so a link points at the step whose label you meant, not at the case it is buried
in. Ids deliberately contain no `#`, which a browser would strip as a
fragment — the link has to survive being pasted, retyped or line-wrapped by a mail client.
A `?demo=` this build does not know, and a `?record=` that matches nothing, both say so on
screen rather than failing silently.

Selecting a record rewrites `?record=` in place rather than pushing a history entry, so
**Copy link** always copies the record on screen, and Back still leaves the demo in one
press instead of walking every row you clicked.

## Tests

`npm test` runs Node's built-in test runner (`node --test`) over the pure cores — the
files that hold no React and touch no DOM, which is exactly why they are separate files
from the views:

| Core | What it has to hold up |
| --- | --- |
| [`shell/parse.ts`](src/shell/parse.ts) | which shape a probe is detected as (JSON array, JSON object, JSONL); a clean file yields every record with `salvaged: false`; a damaged file yields the records around the damage plus a `ParseProblem` and `salvaged: true` |
| [`adapters/rm-r1/cor.ts`](src/adapters/rm-r1/cor.ts) | the Chain-of-Rubrics parser, whose interesting cases are all malformations — fixtures copied from records that are really in the released log, then fuzzed over all 2,985 of them |
| [`adapters/rm-r1/metrics.ts`](src/adapters/rm-r1/metrics.ts) | running the RM-Bench summariser the way its own script runs it reproduces the released `final_result.json`; that reproduction is the control that makes the corrected numbers a finding rather than an opinion |
| [`adapters/rm-r1/model.ts`](src/adapters/rm-r1/model.ts), [`compare.ts`](src/adapters/rm-r1/compare.ts) | fingerprinting, normalisation, which run a score file belongs to, the outcome tables, run alignment, and the record-id convention |
| [`adapters/promptwise/model.ts`](src/adapters/promptwise/model.ts) | recognising a router run, the normalisation from the runner's field names into the view's, and that a package missing something it should have stated is dropped with the reason rather than given a zero |
| [`adapters/arbiteros-preview/model.ts`](src/adapters/arbiteros-preview/model.ts) | the record-id convention again, including that no id contains a `#`, and that a deep link that misses is reported as a miss |
| [`adapters/arbiteros/model.ts`](src/adapters/arbiteros/model.ts) | recognising a replay package, the propagation graph built from `parentId`, min/max on a hand-built chain, which ancestor a propagated label is attributable to, and that a dangling parent or a cycle is reported as data rather than looping forever |

Whether a 22 MB log parses, and which case an emailed deep link resolves to, are checkable
without a browser. There is no test bundler; Node strips the types itself.

Most fixtures are inline; the adapter tests also read the demo packages this repo ships.
Sixteen tests read the released RM-R1 logs, which are **not** in this repository —
they are other people's data, and several are tens of megabytes. Those sixteen run only
when `AGENTLENS_REAL_LOGS` points at that directory, and are reported as *skipped*
otherwise, each with the reason next to it. A skipped test is never counted as a passing
one.

```bash
npm test                                                  # real-log tests report as skipped
AGENTLENS_REAL_LOGS=/path/to/eval/result/<run-id> npm test
```

`AGENTLENS_REAL_LOGS` is one **run** directory — the one holding `reward_bench/`,
`RM-Bench/` and `RMB/`, e.g. `eval/result/RM-R1-Qwen2.5-Instruct-32B` — not the directory
of runs above it. The two-run tests find the sibling run from there themselves. Point it
one level too high and the corpus tests stop finding their files.

Three of the sixteen belong to the parse core, and they are the ones with a size claim in
them:

| Real input | Result | What it exercises |
| --- | --- | --- |
| 15 MB JSON array (RewardBench `logs.json`) | 2,985 records, clean | Virtualised list has to stay smooth at this size |
| 22 MB JSON array (RM-Bench run) | 1,327 records, clean | Largest file M0 must survive; must not block the main thread |
| 20 KB RMB log, **invalid JSON** | 2 of 2 records, salvaged | A trailing comma before the final brace makes `JSON.parse` throw outright; the salvage path recovers both records, points at the offending byte, and labels the file salvaged |

What a deep link *resolves to* is in the suite; what it *lands on* is not. Multi-file
drops, the scroll and focus a `?record=` produces, and the fallback record browser were
driven by hand in a browser against the built site.

## Architecture

Two layers, and the boundary between them is the whole design:

```
shell/      drag-drop · parse worker · sniffing · virtual list · router · theme · lang · RawTree
              ↓  ParsedFile[]
adapters/   rm-r1/ promptwise/ arbiteros/ arbiteros-preview/   ← ship now
            recmem/   ← M4
```

The shell knows nothing about any format. Adapters know nothing about file loading,
workers, salvage, routing, or deployment. Everything crossing the boundary is declared
in [`src/types.ts`](src/types.ts), which is the single source of truth for both sides;
adapters never import from each other.

Three contracts hold it together:

1. **Parsing** — the worker turns a `File` into a `ParsedFile`: `records`, `problems`,
   the detected `shape`, and a `salvaged` flag.
2. **Adapters** — a registry maps a name to an `Adapter`. Sniffing decides who owns the
   data.
3. **Routing** — `?demo=` and `&record=` are parsed into a `RouteState` the adapter
   interprets. Query parameters, not paths, so GitHub Pages needs no SPA rewrite rule.

### Writing an adapter

An adapter is one directory under `src/adapters/` and one object:

```ts
import type { Adapter, ParsedFile } from '../../types'

export const myAdapter: Adapter<MyModel> = {
  // Must equal the roadmap row id this adapter fills — `rm-r1`, `promptwise`,
  // `arbiteros`, `recmem` — or the landing page shows two cards for it: yours,
  // and the "planned" one it could not match. `<row>-<suffix>` marks a preview
  // of `<row>`, which is how `arbiteros-preview` sits beside `arbiteros`
  // without the landing page advertising the row twice.
  name: 'recmem',
  label: 'RecMem memory stores',
  blurb: 'One line describing what this adapter reads.',

  // 0 = not mine, 1 = certain. Only the first few records of each file are
  // passed, so this stays cheap on a 22 MB file. Underscore the file name if you
  // fingerprint on fields alone: `noUnusedParameters` is on.
  sniff(_fileName, firstRecords) {
    return looksLikeMine(firstRecords) ? 0.8 : 0
  },

  // Raw records in, whatever your views need out. May throw; the shell catches
  // and falls back to the raw record browser.
  parse(files: ParsedFile[]): MyModel {
    return buildModel(files)
  },

  View: MyView, // FC<{ model: MyModel; recordId?: string }>

  demos: [
    {
      id: 'recmem',
      label: 'Sample store',
      path: 'demo-data/recmem/sample.json',
      // Required. Demo packages republish other people's data; say whose.
      credit: { text: 'Official memory dumps from …', href: 'https://…' },
    },
  ],
}
```

Register it with one `register(myAdapter)` line in [`src/main.tsx`](src/main.tsx), next
to the existing one — registration happens before the first render so the landing page
can ask the registry what exists. From there, drag-drop, worker parsing, salvage,
sniffing, `?demo=`/`?record=` routing and deployment are already done for you.

That snippet compiles as written; if you change it, `npm run build` is the arbiter.

Rendering is not: the shell hands your `View` the model and gets out of the way. If your
view is a long list, use [`shell/VirtualList`](src/shell/VirtualList.tsx) — it is generic
and takes a `renderRow`, but you have to opt into it. A view that maps 5,000 records to
5,000 DOM nodes will feel exactly as bad as it sounds.

**How sniffing resolves.** A file that declares a top-level
`"agentlens_format": "<name>@<ver>"` hits that adapter directly — an explicit
declaration is by convention the only thing adapters score 1 for — the floor and the
ordering are enforced in code, that ceiling is not. Everything else is scored by field
fingerprint. A drop is one dataset, so an adapter's score is the *mean* of its per-file
scores, and the highest wins if it clears the confidence floor (0.5, in
[`src/shell/sniff.ts`](src/shell/sniff.ts)). Below the floor nobody owns the data and it
goes to the raw record browser, which is a perfectly good answer.

**Demo packages** live in `public/demo-data/`, which Vite copies into the built site.
`DemoPackage.path` is resolved against the site base (`import.meta.env.BASE_URL`), so it
includes the `demo-data/` prefix, as in the example above. Keep packages under 5 MB by
convention so the site stays quick to load — the shell enforces nothing, though the RM-R1
builder fails rather than let its own directory pass 4 MB.

## Roadmap

Four adapters are planned and three of them ship. The table is here so the shape of the project
is legible, not to claim capability:

| Adapter | Artifacts it will read | Status |
| --- | --- | --- |
| `rm-r1` | RM-R1 reward-model evaluation logs (RewardBench, RM-Bench, RMB) | Ships now — M1 |
| `promptwise` | PromptWise cost-aware model-routing decisions, from a run of their learners | Ships now — M2 |
| `arbiteros` | ArbiterOS agent traces: instructions, security labels and their propagation, and the policy verdict — from a replay of the Kernel's red-team cases | Ships now — M3 |
| `recmem` | RecMem memory stores | Planned — M4 |

A fifth adapter is registered and is not a roadmap row: `arbiteros-preview` reads the same
red-team cases unreplayed, as their author wrote them. It stays alongside `arbiteros` rather
than being replaced by it, because a case and a replay of that case are different artifacts.

RM-R1, PromptWise, ArbiterOS and RecMem are other people's systems. AgentLens is an
independent, read-only viewer for the artifacts they produce; it does not modify them
and is not part of them.

## Deployment

Deploying is two steps, and no site exists until you take them:

1. Push to `main`. That runs [`.github/workflows/pages.yml`](.github/workflows/pages.yml),
   which builds and publishes `dist/` to GitHub Pages via `actions/deploy-pages`.
2. **Repository → Settings → Pages → Source must be "GitHub Actions"** — once, by hand.
   The workflow cannot set this for you, and until it is set the run has nowhere to
   publish.

The base path is not a third step. A project site is served from
`https://<user>.github.io/<repo>/` and those paths are case-sensitive, so
[`vite.config.ts`](vite.config.ts) derives `base` from `GITHUB_REPOSITORY`, which Actions
always sets: a fork under any name gets correct asset URLs without an edit. The literal in
that file is only the local fallback for `npm run preview`.

Open the deployed URL and click one demo card before sending the link to anyone.

## Stack

React 19 + TypeScript + Vite, plus `@tanstack/react-virtual` for long lists. Nothing
else, and nothing that talks to a network. M2 renders charts and did **not** add a charting
library: the PromptWise curves are inline SVG polylines, which keeps every number in the DOM
where a screen reader and a text search can still reach it. M3 renders a graph and did not add
a graph library either — dagre went out in M0 and did not come back. That is affordable because
of what these graphs are: the largest of the 105 cases is 41 instructions, and the kernel
numbers the steps itself, so one axis is given and the other is arithmetic. This is a layout you
compute, not a layout problem you need solved. The dependency list is the same three packages M0
shipped with.
