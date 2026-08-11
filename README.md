# AgentLens

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

One adapter ships, and it is deliberately minimal: `arbiteros-preview` reads ArbiterOS
red-team cases (`trace_id`, the prior steps, the call the agent was about to make) and
lists them, one line per case. It exists to prove the shell/adapter seam is real — a
registered adapter that sniffs its own data, builds its own model, and renders its own
view instead of the fallback. It is not the ArbiterOS adapter; **M3 replaces it
wholesale**, and the landing card says so on its face ("M0 preview — the case list only.
The full trace view lands in M3.").

Everything else still falls back. Drop an RM-R1, PromptWise or RecMem log today and you
get the generic record browser with a collapsible JSON tree, because none of those
adapters exists yet. See [Roadmap](#roadmap).

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

**Link to exactly what you mean.** `?demo=<demo-id>&record=<record-id>` preloads a demo
package and selects one record, so a link in an email lands on the specific case you
wanted to show, not on a homepage:

```
<your-pages-url>/?demo=arbiteros-preview&record=cases.json:57
```

Record ids are `<file-name>:<index>` (a bare index when a single file is browsed
raw). They deliberately contain no `#`, so the link survives being pasted, retyped or
line-wrapped by a mail client. A `?demo=` this build does not know, and a `?record=`
that matches nothing, both say so on screen rather than failing silently.

## Tests

`npm test` runs Node's built-in test runner (`node --test`) over the two pure cores:
[`src/shell/parse.ts`](src/shell/parse.ts) and the adapter's
[`model.ts`](src/adapters/arbiteros-preview/model.ts). Both are free of React and the
DOM, which is why they are separate files from the views — whether a 22 MB log parses,
and whether an emailed deep link lands on the right case, are checkable without a
browser. There is no test bundler; Node strips the types itself.

They cover the behaviour the rest of the app is allowed to assume: which shape a probe
is detected as (JSON array, JSON object, JSONL), that a clean file yields every record
with `salvaged: false`, and that a damaged file yields the records around the damage
plus a `ParseProblem` and `salvaged: true` — the salvage contract is the one worth
regression-testing, because it is what stops a bad byte from costing a whole file. On
the adapter side they pin the record-id convention, including that no id contains a `#`.

Most fixtures are inline; the adapter tests read the demo package this repo ships. Three
parse tests read the real research logs below, which are **not** in this repository —
they are other people's data, and two of them are tens of megabytes. Those three run
only when `AGENTLENS_REAL_LOGS` points at that directory, and are reported as *skipped*
otherwise. A skipped test is never counted as a passing one.

```bash
npm test                                    # real-log tests report as skipped
AGENTLENS_REAL_LOGS=/path/to/eval/result npm test
```

| Real input | Result | What it exercises |
| --- | --- | --- |
| 15 MB JSON array (RewardBench `logs.json`) | 2,985 records, clean | Virtualised list has to stay smooth at this size |
| 22 MB JSON array (RM-Bench run) | 1,327 records, clean | Largest file M0 must survive; must not block the main thread |
| 20 KB RMB log, **invalid JSON** | 2 of 2 records, salvaged | A trailing comma before the final brace makes `JSON.parse` throw outright; the salvage path recovers both records, points at the offending byte, and labels the file salvaged |

Multi-file drops, deep links and the fallback record browser were driven by hand in a
browser against the built site; they are not part of the automated suite.

## Architecture

Two layers, and the boundary between them is the whole design:

```
shell/      drag-drop · parse worker · sniffing · virtual list · router · theme · RawTree
              ↓  ParsedFile[]
adapters/   arbiteros-preview/   ← ships now
            rmr1/ promptwise/ arbiteros/ recmem/   ← M1..M4
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
  name: 'my-format',
  label: 'My Format',
  blurb: 'One line describing what this adapter reads.',

  // 0 = not mine, 1 = certain. Only the first few records of each file are
  // passed, so this stays cheap on a 22 MB file.
  sniff(fileName, firstRecords) {
    return looksLikeMine(firstRecords) ? 0.8 : 0
  },

  // Raw records in, whatever your views need out. May throw; the shell catches
  // and falls back to the raw record browser.
  parse(files: ParsedFile[]): MyModel {
    return buildModel(files)
  },

  View: MyView, // React.FC<{ model: MyModel; recordId?: string }>

  demos: [{ id: 'my-sample', label: 'Sample run', path: 'demo-data/my-format/sample.json' }],
}
```

Register it with one `register(myAdapter)` line in [`src/main.tsx`](src/main.tsx), next
to the existing one — registration happens before the first render so the landing page
can ask the registry what exists. From there, drag-drop, worker parsing, salvage,
sniffing, `?demo=`/`?record=` routing and deployment are already done for you.

Rendering is not: the shell hands your `View` the model and gets out of the way. If your
view is a long list, use [`shell/VirtualList`](src/shell/VirtualList.tsx) — it is generic
and takes a `renderRow`, but you have to opt into it. A view that maps 5,000 records to
5,000 DOM nodes will feel exactly as bad as it sounds.

**How sniffing resolves.** A file that declares a top-level
`"agentlens_format": "<name>@<ver>"` hits that adapter directly — an explicit
declaration is the only thing that ever scores 1. Everything else is scored by field
fingerprint. A drop is one dataset, so an adapter's score is the *mean* of its per-file
scores, and the highest wins if it clears the confidence floor (0.5, in
[`src/shell/sniff.ts`](src/shell/sniff.ts)). Below the floor nobody owns the data and it
goes to the raw record browser, which is a perfectly good answer.

**Demo packages** live in `public/demo-data/`, which Vite copies into the built site.
`DemoPackage.path` is resolved against the site base (`import.meta.env.BASE_URL`), so it
includes the `demo-data/` prefix, as in the example above. Keep packages under 5 MB by
convention so the site stays quick to load — nothing enforces that.

## Roadmap

Four adapters are planned; the shipping `arbiteros-preview` is a stand-in for one of
them, not one of them. The table is here so the shape of the project is legible, not to
claim capability:

| Adapter | Artifacts it will read | Status |
| --- | --- | --- |
| `rmr1` | RM-R1 reward-model evaluation logs (RewardBench, RM-Bench, RMB) | Planned — M1 |
| `promptwise` | PromptWise prompt-optimisation traces | Planned — M2 |
| `arbiteros` | ArbiterOS agent traces, including Kernel redteam cases | Preview ships now (`arbiteros-preview`, list only) — full trace view M3 |
| `recmem` | RecMem memory stores | Planned — M4 |

RM-R1, PromptWise, ArbiterOS and RecMem are other people's systems. AgentLens is an
independent, read-only viewer for the artifacts they produce; it does not modify them
and is not part of them.

## Deployment

Deploying is three steps, and no site exists until you take them:

1. Push to `main`. That runs [`.github/workflows/pages.yml`](.github/workflows/pages.yml),
   which builds and publishes `dist/` to GitHub Pages via `actions/deploy-pages`.
2. **Repository → Settings → Pages → Source must be "GitHub Actions"** — once, by hand.
   The workflow cannot set this for you, and until it is set the run has nowhere to
   publish.
3. Check that **`base` in [`vite.config.ts`](vite.config.ts) equals the repo name**
   (`/agentlens/`). A project site is served from `https://<user>.github.io/<repo>/`;
   forking under a different name without changing `base` gives you a blank page and
   404s on every asset.

Open the deployed URL and click one demo card before sending the link to anyone.

## Stack

React 19 + TypeScript + Vite, plus `@tanstack/react-virtual` for long lists. Nothing
else, and nothing that talks to a network. Later milestones add a charting and a graph
library when a milestone actually renders charts or graphs.
