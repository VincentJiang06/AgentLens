# Third-party notices

AgentLens ships a small amount of data it did not produce, so that the demo opens with
something real instead of invented records. Everything here is redistributed under its
original license, unmodified except where stated.

## ArbiterOS red-team cases

`public/demo-data/arbiteros-preview/cases.json` is a repackaging of the 105 red-team case
files under `ArbiterOS-Kernel/redteam/case/` in:

- **Project**: ArbiterOS — https://github.com/cure-lab/ArbiterOS
- **Copyright**: Copyright 2026 cure-lab
- **License**: Apache License 2.0 — http://www.apache.org/licenses/LICENSE-2.0
- **Source revision**: `78a8f98b1f1b4fdd2d875a058f52896cb588f8cf` (2026-06-01)

**Changes made.** The individual case files were concatenated into a single JSON array so
the viewer can fetch one file instead of 105. No field was added, removed or edited: each
entry is the source file's object verbatim (`trace_id`, `prior`, `current`), and no case
was filtered out or synthesised.

**Why it is here.** These cases are the adversarial scenarios ArbiterOS's own test harness
runs, and they are what makes the preview adapter show real agent behaviour rather than a
lorem-ipsum list. They are published in a public Apache-2.0 repository. If the ArbiterOS
maintainers would prefer this copy not be redistributed, it will be removed on request —
open an issue and it goes.

The Apache License 2.0 requires that redistributions carry the above attribution and a
copy of the license; see `LICENSE-APACHE-2.0.txt` in this directory.
