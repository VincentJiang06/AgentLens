# Demo data builders

**English** · [中文](#中文)

Scripts that turn somebody's real logs into the small packages under
`public/demo-data/`. The **output is committed**; nothing in `npm run build`, `npm run
dev` or the deployed site runs these. They live here so the sampling can be argued with
instead of taken on trust: the demo is what a visiting researcher sees before deciding
whether to keep reading, and it republishes their data.

| Script | Writes | Needs |
| --- | --- | --- |
| `rm-r1.mjs` | `public/demo-data/rm-r1/rm-r1-32b.json`, `public/demo-data/rm-r1/rm-r1-compare.json` | a clone of [RM-R1-UIUC/RM-R1](https://github.com/RM-R1-UIUC/RM-R1) with its `eval/result/` logs |

Plain node ESM, no dependencies, no network.

---

## `rm-r1.mjs`

```sh
node scripts/build-demo-data/rm-r1.mjs /path/to/RM-R1/eval/result
# or
AGENTLENS_REAL_LOGS=/path/to/RM-R1/eval/result/<run-id> node scripts/build-demo-data/rm-r1.mjs
```

Three spellings of the same place are accepted: `eval/result`, the repo root (it looks for
`eval/result` one level down), and **one run directory** under `eval/result` (it takes the
parent, because it reads two runs). The third is what `AGENTLENS_REAL_LOGS` means to the
test suite, so the variable can be set once and be right for both. With neither an argument
nor `AGENTLENS_REAL_LOGS` it exits 1 and says what it wanted. The source logs are ~130 MB
and are not in this repository.

It prints the sample composition, the three reproduction blocks below — RM-Bench,
RewardBench, and the two-run agreement — then each package's coverage block and the sizes.
Rebuilding is byte-identical: two runs in a row print the same `sha256`. Every assertion it
makes is fatal, and every one of them runs before a byte is written except the read-back check,
which deletes what it wrote. So a build that reaches the `wrote …` lines is a build that
passed, and a build that fails leaves nothing behind to be committed past the error.

### What comes out

Two packages, each a single JSON **object** (not an array) declaring
`"agentlens_format": "rm-r1@1"` — which is what makes the shell hand it straight to the
`rm-r1` adapter: `shell/sniff.ts` matches the name before the `@` against the registered
adapter's own name, so the tag has to be the adapter's name and not the format's. The
shell's parser reads each package as exactly **one record** whose value is the whole
bundle.

```jsonc
{
  "agentlens_format": "rm-r1@1",
  "built_by": "scripts/build-demo-data/rm-r1.mjs",
  // Every sentence below is an { "en", "zh" } pair; every identifier is a bare string.
  "bundle":   { "id", "title", "credit": { "en", "zh" },
                "source_repo", "source_license", "source_root" },
  "sampling": { "deterministic", "method": { "en", "zh" }, "rules": [ { "en", "zh" } ],
                "hand_picked": [...],   // deep-link targets: source_index, subset, record_id, why: {en,zh}
                "withheld": [...],      // left out for what is in it: source_path, records, reason: {en,zh}
                "excluded": [...],      // left out mechanically: source_path, reason: {en,zh}
                "truncated": [...] },   // source_path, source_index, record_id, field, bytes before/after
  "coverage": [                           // which figures are whose, one by one
    { "figure": { "en", "zh" }, "basis": { "en", "zh" }, "denominator",
      "from": { "en", "zh" }, "note": { "en", "zh" } }
  ],
  "notes":    [ { "en", "zh" } ],         // straight into RmR1Model.notes, both languages
  "featured_record": { … },               // main package only; the deep-link target
  "runs": [
    {
      "run_id": "RM-R1-Qwen2.5-Instruct-32B",
      "logs": [                           // sampled records, verbatim from the source
        { "run_id", "source_path", "benchmark", "source_total", "sampled",
          "source_indices": [ … ],        // parallel to `records`
          "accuracy": { "sample", "full_set" },   // RewardBench only
          "style_pairing": 1,                     // RM-Bench only: which file, 1|2|3
          "records": [ … ] }
      ],
      "outcome_tables": [                 // complete, never sampled
        { "run_id", "benchmark", "complete": true, "count",
          "source_path",                  // RM-Bench states "source_paths": all three files
          "align_on": "source_index",
          "columns": [ … ], "rows": [ [ … ], … ] }
      ],
      "scores": [
        { "run_id", "source_path", "dropped_keys": [ … ], "value": { … } }
      ]
    }
  ]
}
```

`run_id` repeats on every log, table and score entry, not just on the run around
them. A compare package ships two runs whose files have the same names and whose
outcome tables have the same shape, and an official score belongs to exactly one
checkpoint: a figure that cannot name its run may not be shown at all, so the run
travels with the number rather than with its container.

`align_on` is `source_index` and not `id`, because RewardBench's `id` is not
unique in these logs — 3692 appears twice, once under `donotanswer` and once
under `hep-python`. Position in the source file is unique, and the build checks
that the two released runs agree on `id` and `subset` at all 2985 positions
before it packs them, so joining the two tables on `source_index` joins the same
items.

**Every sentence a package puts on screen is written in both languages** — `notes`, the
`sampling` rules, `method`, each hand-picked `why`, each withheld and excluded `reason`,
every `coverage` `figure`, `basis`, `from` and `note`, and `bundle.credit`. Each is an
`{ "en", "zh" }` pair, and `assertBilingual` refuses to write a package where one side is
missing or is a copy of the other; it prints how many sentences it checked (56 and 42 for
the two packages). The adapter also accepts a bare string in any of those places and shows
it to both readerships, which is right for a package somebody else wrote — their words
untranslated beat a guess at what they meant — so an older package still opens. Our own
packages are held to the stricter rule, because the half of the disclosure that carries the
denominators and the sampling contract is exactly the half a misreading turns on.

Anything inside a sentence that came out of the logs — run ids, file names,
`Is_Chosen_Answer_Shuffled_toPositionB`, JSON pointers into the package, every count — is
the same characters on both sides. That is the same rule the shell's `Str` states for
AgentLens's own words: the language is translated, the data never is. The `figure`,
`basis`, `from` and `note` of a coverage entry are `Str` in `contract.ts` for the same
reason; where code has to branch on a basis it branches on `basis.en`, the enumerated
vocabulary this builder asserts against.

`records` are the source objects **unchanged** — same field names, same
`Is_Chosen_Answer_Shuffled_toPositionB` spelling, same string `id` on RM-Bench — so an
adapter reads a bundled record with exactly the code it uses for a dropped file. The one
exception is a truncated record, which gains an `agentlens_truncated` field naming the
field that was cut.

`outcome_tables` are column-oriented (`columns` + `rows` of arrays) because that is the
difference between 102 KB and 332 KB for the same 2985 RewardBench rows, and 72 KB against
152 KB for the 1327 RM-Bench ones. The columns are

```
rewardbench  source_index, id, subset, results, Is_Chosen_Answer_Shuffled_toPositionB
rm-bench     source_index, id, domain, result_1, result_2, result_3   // one triple per style file
```

which is everything the full-benchmark figures need: the group for a per-subset or
per-domain tally, the outcome, the three style files' triples for the 3×3 matrix, the
shuffle flag for the compare view's normalisation claim, and `source_index` to join two
runs' tables row for row.

| Package | Contents | Size |
| --- | --- | --- |
| `rm-r1-32b.json` | one run, all four log families, both outcome tables, eight score files | 2,939 KB (562 KB at `gzip -9`) |
| `rm-r1-compare.json` | two runs on the same RewardBench items, both outcome tables complete | 652 KB (146 KB at `gzip -9`) |

Budget is 4 MB for the directory and the script fails rather than exceed it.

### The sampling rule

Two things had to be true at once: a reader must be able to click into real judgements,
and no number on screen may be the sample's when it looks like the benchmark's. So the
package is in two halves.

**Complete, never sampled — the outcome tables.** Position, `id`, group and outcome for
*every* record in the source file — plus the harness's A/B shuffle flag on RewardBench and
all three style files' result triples on RM-Bench — for all 2985 RewardBench items and all
1327 RM-Bench ids, for every run in the package, each table tagged with the run it belongs
to. That costs 102 KB and 72 KB, and it is what every leaderboard-named figure on screen is
computed from: per-subset accuracy, the four RewardBench sections, and the RM-Bench 3×3
style matrix with its four metrics.

In the compare package the same tables carry what a run-to-run agreement matrix needs over
all 2985 items, joined on `source_index` rather than taken from the 40 whose text travels.
The build computes exactly that from the two packed tables and prints it below, and the
Compare tab reads them: the matrix, the two headline accuracies and the per-group movement
are over all 2985, each side named by the `run_id` its own table carries. Where no complete
table is in hand for both sides — two files dropped by hand, say — the tab does not fall
back to an unattributed number: it aligns the records it has and says in the same sentence
that those are the loaded records' rates and not the benchmark's.

That is a claim about the *file*, so the build checks it against the run's own released
score files and the compare package's agreement matrix against the two packed tables, and
refuses to write a package where either stops holding — see "What the build verifies" below,
where the worst difference across all 33 checked RewardBench values is `0`.

What the tables cannot give is anything that needs the judge's text: the browser's list of
judgements and every count inside it, the sample's own accuracy, the compare view's A/B
position note — the shuffle flag is in the table, but the `[[A]]`/`[[B]]` letters it has to
be read against are only in the text — and anything read out of a Chain-of-Rubrics trace.
Those are the sample's and must be shown as the sample's. Rather
than leave that to be remembered, each package carries a `coverage` block naming its figures
one at a time with the denominator each is over and where in the package it comes from. The
build prints it, so it is in the build log as well as in the file:

```
rm-r1 — coverage, as the package declares it:
  [full benchmark ] n=2985  RewardBench accuracy by subset (all 23)
  [full benchmark ] n=2985  The four RewardBench sections (Chat, Chat Hard, Safety, Reasoning),
                            avg_Result_each_section and absoluate_Result
  [full benchmark ] n=1327  The RM-Bench 3x3 style matrix, per domain and overall, and
                            hard_acc / normal_acc / easy_acc / total_avg_acc
  [as released    ] n=6     RMB: judgements only. No RMB accuracy is computed or shown anywhere.
  [this sample    ] n=232   The judgement browser: which records can be opened and read, and
                            every count and filter inside it
  [this sample    ] n=232   This sample's own accuracy
  [this sample    ] n=232   Anything read out of a Chain-of-Rubrics trace: rubric route, criteria,
                            evidence spans, whether an <answer> tag is present

rm-r1-compare — coverage, as the package declares it:
  [full benchmark ] n=2985  RewardBench accuracy by subset, and the four sections —
                            RM-R1-Qwen2.5-Instruct-32B
  [full benchmark ] n=2985  RewardBench accuracy by subset, and the four sections —
                            RM-R1-DeepSeek-Distilled-Qwen-32B
  [full benchmark ] n=2985  The run-to-run agreement matrix (both right / one only / both wrong)
                            and the per-group movement beside it
  [this sample    ] n=40    The A/B position note: how often the two runs shuffled the slots
                            differently, and how often the raw [[A]]/[[B]] letters would
                            disagree with the normalised verdict
  [this sample    ] n=40    The judgement browser and the side-by-side reading of a disagreement
```

A view may put a figure under a benchmark's own name only where `basis` is
`full benchmark`, and in the compare package every such figure names the run it belongs to —
two runs are loaded, so a number that cannot say whose it is may not be shown at all. The
block is itself asserted: a `full benchmark` denominator has to be the row count of a
complete outcome table actually in the package, and a `this sample` denominator has to be a
packed log's own `sampled` count.

**How the four RewardBench sections are computed**, since it is not the obvious thing and
the obvious thing is wrong. Two formulations reproduce the released `main_score.json` on a
complete outcome table, the build asserts *both* against it, and a view may use either:

- plain accuracy over every record in the section — **except Reasoning**, which is the mean
  of `math-prm`'s accuracy and the mean of the six `hep-*` accuracies;
- RewardBench's own `EXAMPLE_COUNTS` weighting of the 23 per-subset accuracies, which is
  what `rewardbench/constants.py` does.

They agree because those weights *are* the row counts in these logs everywhere except
`math-prm`, which has 447 rows and weighs 984 — and that one difference is exactly what
makes Reasoning half maths and half code rather than a record-count average. On Reasoning
the two agree by construction rather than by luck: 984 of 1968 is exactly half, so the
weighting *is* "half `math-prm`, half the `hep-*` mean".

The carve-out is the whole point, so it is worth stating as a number. Plain accuracy over
Reasoning's 1431 rows — the third formulation, the one without the carve-out — is
`0.96016771` for the 32B run where the released file says `0.95211300`, 0.81 of a point
apart; on the DeepSeek-distilled run it is `0.96366177` against `0.96808309`, 0.44 of a
point the other way. That formulation is therefore **not** among the two the build checks,
and nothing in the packages may say it is: it would fail the assert, which is how the claim
stays worth reading. On a *sample* all three come apart and none of them is the section
score; the weights are only ever applied to a complete set of outcomes.

**Sampled — the full records**, the ones with the prompt, both responses and the
Chain-of-Rubrics text. Selection is **stratified systematic sampling**: no RNG, no seed,
just fixed strides through the source file's own order, so nobody could have tuned a seed
until the sample looked good and a rebuild is byte-identical.

- **RewardBench** — 10 records from each of the 23 subsets, of which **up to 4 are
  judgements the model got wrong**. Only 211 of 2985 are wrong overall, so mistakes are
  over-represented several times over. That is deliberate and it is the non-flattering
  direction: a judgement browser earns its keep on the failures. It also means the
  sample's accuracy (0.655) is nothing like the benchmark's (0.929), so both numbers are
  written into the package under `logs[].accuracy` and neither may be shown without the
  other.
- **RM-Bench** — 6 ids from each of the five raw `domain` values (`safety-refuse` and
  `safety-response` are kept apart here even though the official scorer folds them with
  `startswith`), split across ids the judge got right on all nine style pairings, wrong on
  all nine, and mixed. Each sampled id is taken from **all three** style files: a 3×3 cell
  needs all three, so sampling by file rather than by id would leave the matrix
  unbuildable.
- **RMB** — every record of every RMB log that ships, because the released RMB logs are 2
  records per file. That is 6 records in 3 files (the fourth is withheld, below), which is
  not the RMB benchmark and is not treated as it: no RMB accuracy is computed anywhere, and
  the `coverage` entry says so in the package.
- **Compare package** — the same 40 source indices from both runs, drawn only from items
  the two runs answer *differently* (16 each way) plus items both get wrong (8). Each run
  is right on exactly 16 of the 40 *by construction*, which is a property of the sample and
  of neither checkpoint; over the benchmark they score 92.93% and 92.46%. The agreement
  matrix is built from the two complete tables joined on `source_index` — 2668 both right,
  106 only the Qwen run, 92 only the DeepSeek run, 119 both wrong, over all 2985 items —
  and the build recomputes exactly that from the packed tables and fails if they do not
  align on `id` and `subset` at every row.

**Oversize records** (>20 KB, or >70 KB for an RM-Bench id's three records) are passed
over in favour of the next candidate in the same stratum. One record survives that:
`reward_bench` index 308, one of only two mistakes `mt-bench-easy` contains at all, a 44 KB
trace where the judge falls into `H₂O + H₂O + H₂O…` and never emits a verdict. It is kept
and cut **from the middle** — head and tail stay, with a sentence in the gap saying what
was removed — because a tail cut would delete the `<answer>` tag and make a parse report
"no verdict" for records that have one. This one genuinely has none, which is why it is
worth keeping. It is listed in `sampling.truncated` with the bytes before and after and the
`record_id` of the record it happened to, so the disclosure links to the thing it is about.

**Two hand-picked records** are added on top of the RewardBench quota as deep-link
targets, listed in `sampling.hand_picked` with the reason, the source index, the subset and
the `record_id` the shell's `?record=` link uses, and counted in the sample accuracy like
everything else. `featured_record` names the first of them.

**Everything the release holds and this package does not.** A sampling rule that only says
what was kept says nothing about what was dropped, so the build walks the run's own released
directory and requires every file to be one of three things: packed, listed in
`sampling.withheld` (left out for what is in it), or listed in `sampling.excluded` (left out
mechanically). A file that is none of them stops the build until someone writes down what it
is. For `RM-R1-Qwen2.5-Instruct-32B` that is 19 released files — 15 packed, 1 withheld, 3
excluded:

| Not in the package | Why |
| --- | --- |
| `RMB/BoN_set_Harmlessness/log_result/raw_logs.json` | withheld: the rejected response *is* the demeaning content the item tests refusal of |
| `RMB/BoN_set_Harmlessness/log_result/group_by_same_id_logs.json` | the same two withheld records, regrouped by id |
| `RMB/BoN_set_Helpfulness/log_result/group_by_same_id_logs.json` | not valid JSON in the release (a trailing comma), and a demo package has to parse |
| `RM-Bench/logs/final_result.json` | byte-identical duplicate of `RM-Bench/final_result.json`, which is packed |

The last two reasons are themselves claims, so they are checked: the build parses the file
it calls invalid, hashes the file it calls a duplicate against the one it packs, and
compares the regrouped Harmlessness file against the withheld raw log record for record.
A wrong reason fails the build the same way a missing one does.

The stride, the mistake quota, the two hand-picked records, the withheld pair and that
accounting are the whole defence against a charge of cherry-picking, so they are in
`sampling` inside each package — where a view can render them — and not only in this file.

### Redaction

`reward_bench/score_result/each_small_section_score.json` carries an internal
training-run name under `model` — a checkpoint path that spells out the training data
recipe. Both released runs have one. It is not ours to redistribute.

The builder drops `model`, `model_type` and `chat_template` from every score file, and
then checks the result three ways. The first two abort before anything is written; the
third aborts after writing and deletes what it wrote:

1. every remaining leaf under `scores` must be a **number** — a name is a string, so this
   catches the next leaked field without knowing what it will be called. It reports the
   path and the type and never the value, because a build log is a place things get pasted
   from;
2. the serialised bytes of both packages must not match `/wzq016/i` or `/filtered_sky/i`,
   checked before anything touches the disk, so a failure leaves no file behind;
3. the file is read back off disk after writing and checked again — and if *that* fails the
   file is deleted, since the whole point of checking the bytes on disk is that those bytes
   are what would be committed.

All three are verified by breaking them, and were re-verified against the packages committed
here. Dropping `model` from the redaction list stops the build at (1):

```
score file …/each_small_section_score.json.model still holds a string
where every leaf must be a number — add it to `drop`
```

neutering (1) as well stops it at (2), `rm-r1-32b.json contains /wzq016/i — redaction
failed, nothing was published`, with the committed packages untouched on disk; neutering (1)
and (2) stops it at (3), `rm-r1-32b.json on disk contains /wzq016/i — redaction failed; the
file was deleted rather than left where it could be committed`, which deletes that file and
leaves the other package's earlier output alone.

`grep -ri "wzq016\|filtered_sky" public/demo-data/` should stay silent. It is checked
against the built packages, not against this repository's own source: the two regexes above
live in the builder as guard patterns, and a fragment of a name is not the recipe.

One exclusion is content, not redaction: the two `RMB/BoN_set_Harmlessness` records are
withheld, because the rejected response *is* the demeaning content the item tests refusal of
and the demo makes its point without republishing it on a public page. That is recorded in
`sampling.withheld`, not done quietly, and the regrouped copy of the same two records is in
`sampling.excluded` for the same reason. Drop the original file into AgentLens to see them.

### What the build verifies

Printed on every run, and fatal if any of it stops holding:

```
rm-r1: 56 sentences, both languages written
rm-r1-compare: 42 sentences, both languages written

RewardBench sample: 232 of 2985, 23 subsets, 80 wrong
  (sample accuracy 0.6552, full set 0.9293)
RM-Bench sample: 30 ids x 3 style files = 90 records of 3981
truncated records: 1

RM-Bench, from the complete outcome table in the package:
  metric          shipped   script as written   with data2 read from file 2
  chat           76.49   76.49               74.94
  code           66.08   66.08               65.79
  math           80.55   80.55               80.24
  safety         93.83   93.83               93.60
  hard_acc       70.49   70.49               67.23
  normal_acc     80.51   80.51               80.51
  easy_acc       86.71   86.71               88.18
  total_avg_acc  79.24   79.24               78.64

RewardBench, from the complete outcome table in the package:
  section                  released   from the packed table
  Chat                   95.25      95.25
  Chat Hard              83.11      83.11
  Safety                 91.89      91.89
  Reasoning              95.21      95.21
  avg_Result_each_section 91.37      91.37
  absoluate_Result       92.93      92.93
  23 per-subset accuracies also reproduce each_small_section_score.json. The four
  sections reproduce main_score.json two ways: as the released files were made — Chat,
  Chat Hard and Safety plain over the section's records, Reasoning as the mean of
  math-prm and the mean of the six hep-* — and as the benchmark's own EXAMPLE_COUNTS
  weighting of the per-subset accuracies, which on Reasoning is the same thing (984 of
  1968 is exactly half). Plain accuracy over Reasoning's 1431 rows is 96.0168%, not the
  released 95.2113% — that third formulation is not checked, because it is not the
  section score. Worst difference across all 33 checked values: 0

Compare package, agreement over all 2985 items
(from the two packed tables, joined on source_index):
  both right 2668 · only RM-R1-Qwen2.5-Instruct-32B 106 ·
  only RM-R1-DeepSeek-Distilled-Qwen-32B 92 · both wrong 119
```

followed by each package's `coverage` block, printed above.

Also asserted: all 23 subsets present, and named by the section map — a subset it does not
name would drop silently out of a section score; both correct and incorrect judgements
present; the three RM-Bench style files sampled on identical ids; the two runs index-aligned
on `id` and `subset`; `results` only ever 0 or 1; every released file either packed,
withheld or excluded with a reason, and the mechanical reasons re-checked against the files
themselves; every `coverage` denominator matching a table or a packed log actually in the
package; every sentence in `notes`, `sampling`, `coverage` and `bundle.credit` written in
both languages, with neither side blank nor a copy of the other; each written file parses
back and still declares its format; and the directory under 4 MB.

The RewardBench block is why the per-subset table and the four section tiles are allowed to
carry their leaderboard names. `0` is the literal worst difference, not a rounding of one:
the packed table and the released score files agree bit for bit on all 33 values, for both
runs of the compare package as well. The agreement block makes the same argument for the
compare view: it is recomputed here from the two shipped tables, and the Compare tab
recomputes it from the same two tables in the browser, so the four cells it draws are the
benchmark's and not the 40 records' it can display. The four numbers printed below are
therefore the four numbers on screen.

The RM-Bench block is the reason the outcome table ships complete.
`eval/RM-Bench/scripts/process_final_result.py` computes `output_path2` and then never
uses it — `data2` is loaded from `output_path3` — so `total_dataset_2` is discarded and
`total_dataset_3` counted twice. Three of the nine matrix cells collapse onto their
neighbours; `hard_acc` and `easy_acc` move, `normal_acc` cannot. The middle column above
reproduces the script as written and matches the shipped `final_result.json` on all eight
metrics to within 1e-9 — the build fails if it ever does not — and that match is what
licenses the right-hand column: it differs by that one line and nothing else.

Everything in all three blocks is derivable from the shipped packages alone, which is the
point. A view recomputes them from the file rather than being told, and a reader who
downloads the file can do the same.

### Attribution

The packages carry their own `bundle.credit` — an `{ "en", "zh" }` pair like every other
sentence they write, and the text `Adapter.demos[].credit` should use, so the attribution
travels with the file rather than depending on someone remembering the README. What is
named inside it is data and is identical on both sides: the run ids, `RM-R1-UIUC/RM-R1` and
`Apache-2.0`. Long-form attribution and the Apache-2.0 terms belong in
`THIRD_PARTY_NOTICES.md` at the repo root.

---

## 中文

[English](#demo-data-builders) · **中文**

把别人的真实日志变成 `public/demo-data/` 下那些小包的脚本。**输出是提交进仓库的**；
`npm run build`、`npm run dev` 和部署好的站点都不会运行这些脚本。它们放在这里，
是为了让抽样可以被质疑，而不是被将就地信任：演示是一位来访的研究者在决定要不要继续读之前
看到的东西，而且它再分发的是别人的数据。

| 脚本 | 写出 | 需要 |
| --- | --- | --- |
| `rm-r1.mjs` | `public/demo-data/rm-r1/rm-r1-32b.json`、`public/demo-data/rm-r1/rm-r1-compare.json` | 一份带 `eval/result/` 日志的 [RM-R1-UIUC/RM-R1](https://github.com/RM-R1-UIUC/RM-R1) 克隆 |

纯 node ESM，无依赖，不联网。

### 用法

```sh
node scripts/build-demo-data/rm-r1.mjs /path/to/RM-R1/eval/result
# 或
AGENTLENS_REAL_LOGS=/path/to/RM-R1/eval/result/<run-id> node scripts/build-demo-data/rm-r1.mjs
```

同一个位置有三种写法都接受：`eval/result`、仓库根目录（脚本会往下找一层的 `eval/result`），
以及 `eval/result` 下的**某一个运行目录**（脚本会取它的上一层，因为它要读两个运行）。
第三种正是 `AGENTLENS_REAL_LOGS` 对测试套件的含义，所以这个变量设一次就能同时给测试和构建脚本用。
既没有参数也没有 `AGENTLENS_REAL_LOGS` 时它以 1 退出，并说明它想要什么。
源日志约 130 MB，不在本仓库里。

它会打印样本构成、上面英文部分那三段复现结果（RM-Bench、RewardBench、两个运行的一致性），
然后是每个包的 `coverage` 块和文件体积。重建是逐字节一致的：连跑两次打印出同样的 `sha256`。
它做的每一个断言都是致命的，而且除了写回读取那一项之外全部在写出任何字节之前完成——
写回读取失败会删掉刚写的文件。所以，一次跑到 `wrote …` 那几行的构建就是通过了的构建，
而失败的构建不会留下任何可能被误提交的东西。

### 输出的是什么

两个包，各是一个 JSON **对象**（不是数组），顶层声明 `"agentlens_format": "rm-r1@1"`——
外壳正是靠它把包直接交给 `rm-r1` 适配器：`shell/sniff.ts` 拿 `@` 前面的名字去和已注册适配器的
名字比对，所以这个标记写的必须是适配器名而不是格式名。外壳的解析器把整个包读成**一条记录**，
它的值就是整个 bundle。结构见上面英文部分的 JSON 骨架。

`run_id` 重复出现在每一条日志、每一张结果表和每一份分数上，而不只是挂在外层的运行上。
对照包里有两个运行，它们的文件同名、结果表同形，而一份官方分数只属于一个 checkpoint：
说不清属于哪个运行的数字根本不许显示，所以运行标识跟着数字走，而不是跟着容器走。

`align_on` 用的是 `source_index` 而不是 `id`，因为 RewardBench 的 `id` 在这些日志里并不唯一——
3692 出现了两次，一次在 `donotanswer`，一次在 `hep-python`。在源文件中的位置是唯一的，
而且构建会在打包前检查两个发布运行在全部 2985 个位置上的 `id` 和 `subset` 都一致，
所以按 `source_index` 连接两张表连接的是同一批题目。

**包里每一句会出现在屏幕上的话都写了两种语言**——`notes`、`sampling` 的各条规则、`method`、
每条手选记录的 `why`、每个保留不发与不予收录文件的 `reason`、`coverage` 每一条的
`figure`／`basis`／`from`／`note`，以及 `bundle.credit`。每一处都是 `{ "en", "zh" }` 这样一对，
少一边、或者两边是同一段文字，`assertBilingual` 都会拒绝写出，并把它检查过的句子数打印出来
（两个包分别是 56 句和 42 句）。适配器在这些位置上同样接受纯字符串，并把它同时给两种读者——
别人写的包就该这样，原样引用他们的话胜过替他们猜——所以旧包依然打得开。
我们自己的包按更严的规矩来：交代里带着分母和抽样约定的那一半，恰恰就是误读会栽在上面的那一半。

句子里凡是从日志来的东西——运行名、文件名、`Is_Chosen_Answer_Shuffled_toPositionB`、
指向包内位置的 JSON 路径、每一个计数——两边写的是同一串字符。这跟外壳里 `Str` 对 AgentLens
自己那些话立下的规矩是同一条：语言要翻译，数据永远不翻译。`coverage` 条目的 `figure`、`basis`、
`from`、`note` 在 `contract.ts` 里是 `Str`，也是同一个道理；代码需要按 basis 分支时，
一律看 `basis.en`——那一边才是本构建脚本断言的那套固定词汇。

`records` 是**未经改动**的源对象——同样的字段名、同样的 `Is_Chosen_Answer_Shuffled_toPositionB`
拼写、RM-Bench 上同样的字符串 `id`——所以适配器读包里的记录和读拖入的文件用的是同一段代码。
唯一的例外是被截断的那条记录，它多了一个 `agentlens_truncated` 字段，写明被截的是哪个字段。

`outcome_tables` 是列式的（`columns` 加数组组成的 `rows`），因为同样 2985 行 RewardBench 数据，
这是 102 KB 与 332 KB 的差别；1327 行 RM-Bench 则是 72 KB 与 152 KB。列就是全量数字所需要的一切：
分子集或分领域统计用的分组、判对判错的结果、3×3 矩阵需要的三个风格文件的结果三元组、
对照视图归一化所需的位置打乱标记，以及把两个运行逐行对齐用的 `source_index`。

| 包 | 内容 | 体积 |
| --- | --- | --- |
| `rm-r1-32b.json` | 一个运行、四类日志、两张结果表、八份分数文件 | 2,939 KB（`gzip -9` 后 562 KB） |
| `rm-r1-compare.json` | 同一批 RewardBench 题目上的两个运行，两张结果表都完整 | 652 KB（`gzip -9` 后 146 KB） |

整个目录的预算是 4 MB，超了脚本直接失败，而不是照写。

### 抽样规则

有两件事必须同时成立：读者要能点进真实的判例；而屏幕上任何看起来像基准的数字，都不能其实是
样本的。所以包分成两半。

**完整、从不抽样——结果表。** 源文件里*每一条*记录的位置、`id`、分组和结果，
外加 RewardBench 上评测脚本的 A/B 位置打乱标记、RM-Bench 上三个风格文件的结果三元组；
覆盖全部 2985 条 RewardBench 题目和全部 1327 个 RM-Bench id，包里每个运行都有一份，
每张表都标着它属于哪个运行。代价是 102 KB 和 72 KB，而屏幕上每一个挂着榜单名字的数字都由它算出：
分子集准确率、RewardBench 的四个大项，以及 RM-Bench 的 3×3 风格矩阵和它的四个指标。

在对照包里，同样这两张表也带着“运行间一致性矩阵”在全部 2985 条上所需的一切，按 `source_index` 连接，
而不是取自那 40 条带文本的记录；构建脚本就是这么算的，并把结果打印出来。对照页读的就是这两张表：
一致性矩阵、两个运行各自的总体准确率、以及按分组的移动，都是在全部 2985 条上算的，
每一边的名字来自它自己那张表里的 `run_id`。要是两边都没有完整结果表——比如手工拖进来两个文件——
对照页不会退回一个说不清归属的数字：它只对齐手上有的记录，并在同一句话里写明这是已载入记录上的比率，
不是整个基准上的。

这是关于**文件**的断言，所以构建会拿它去对该运行自己发布的分数文件，
以及拿对照包的一致性矩阵去对两张打包好的表，任何一项不再成立就拒绝写出——
见英文部分的“What the build verifies”，其中 33 个被检查的 RewardBench 数值最大差异是 `0`。

结果表给不了的，是任何需要判决文本的东西：判例浏览器的列表和它里面的每一个计数、样本自身的准确率、
对照页的 A/B 位置注记——位置打乱标记确实在表里，但要跟它对着读的 `[[A]]`/`[[B]]` 字母只在文本里——
以及从 Chain-of-Rubrics 推理里读出的一切。这些属于样本，也必须以样本的名义显示。
与其指望有人记得这件事，每个包都带一个 `coverage` 块，逐条列出它的每个数字、各自的分母、
以及在包里从哪来。构建会把它打印出来，所以它既在文件里也在构建日志里（见英文部分的两段 coverage）。

只有 `basis` 是 `full benchmark` 的数字，视图才可以把它放在基准自己的名字下；
在对照包里，这样的数字还必须写明属于哪个运行——两个运行都载入了，说不清是谁的数字就一点也不许显示。
这个块本身也被断言：`full benchmark` 的分母必须等于包里某张完整结果表的行数，
`this sample` 的分母必须等于某份打包日志自己的 `sampled` 计数。

**RewardBench 的四个大项是怎么算的**，因为这并不是想当然的那样，而想当然的那种算法是错的。
有两套算法能在完整结果表上重现发布的 `main_score.json`，构建把**两套**都拿去对它，视图用哪套都行：

- 该大项全部记录上的普通准确率——**Reasoning 除外**，它是 `math-prm` 的准确率与六个 `hep-*`
  准确率均值这两者的平均；
- RewardBench 自己的 `EXAMPLE_COUNTS` 加权，对 23 个分子集准确率加权，也就是
  `rewardbench/constants.py` 的做法。

两者相等，是因为在这些日志里那些权重*就是*各子集的行数，只有 `math-prm` 例外：它有 447 行，
权重却是 984——而正是这一处差别，让 Reasoning 变成一半数学一半代码，而不是按记录数平均。
在 Reasoning 上，这两套相等是必然的，不是碰巧：1968 里的 984 正好是一半，
所以那套加权*就是*「一半 `math-prm`，一半 `hep-*` 的均值」。

这条例外正是要点，所以值得用数字讲清楚。不带这条例外的第三种算法——在 Reasoning 的 1431 行上
算普通准确率——对 32B 这个运行得到 `0.96016771`，而发布的文件写的是 `0.95211300`，差 0.81 个点；
在 DeepSeek 蒸馏的那个运行上是 `0.96366177` 对 `0.96808309`，往另一个方向差 0.44 个点。
所以第三种算法**不在**构建检查的那两套之列，包里也不许说它在：真拿它去检查会直接让构建失败，
而这正是这个说法值得读的原因。在*样本*上三种算法都会分道扬镳，而且哪一种都不是大项分数；
权重只允许施加在完整的结果集上。

**抽样的部分——完整记录**，也就是带问题、两个回答和 Chain-of-Rubrics 文本的那些。选取方式是
**分层系统抽样**：不用随机数发生器，不设种子，只是按源文件自身的顺序以固定步长取，
这样既没人能调种子调到样本好看为止，重建也是逐字节一致的。

- **RewardBench** — 23 个子集各取 10 条，其中**最多 4 条是模型判错的**。全量 2985 条里判错的只有
  211 条，所以错误被超采了好几倍。这是刻意的，而且是不讨好的那个方向：判例浏览器的价值正在失败样例上。
  这也意味着样本的准确率（0.655）与基准的准确率（0.929）完全不像，因此两个数都写进包的
  `logs[].accuracy`，且**任何一个都不许脱离另一个单独显示**。
- **RM-Bench** — 五个原始 `domain` 值各取 6 个 id（`safety-refuse` 与 `safety-response` 在这里
  分开对待，尽管官方脚本用 `startswith` 把它们合并），并在“九个风格配对全对”“全错”“有对有错”
  三类之间分配。每个被选中的 id 都从**三个**风格文件里各取一条：一个 3×3 单元格需要三个都在，
  按文件而不是按 id 抽样会让矩阵建不起来。
- **RMB** — 随包发布的每个 RMB 日志的全部记录，因为公开的 RMB 日志每个文件只有 2 条。
  合计 3 个文件 6 条记录（第四个被保留不发，见下），这不是 RMB 基准，也没有被当成它：
  任何地方都不计算、不显示 RMB 的准确率，包里的 `coverage` 条目也这么写着。
- **对照包** — 两个运行取同样的 40 个 source index，只从两个运行判得**不一样**的题目（各 16 条）
  加上两个都判错的题目（8 条）里取——这正是对照视图存在的理由，也是文件里最难的那些题。
  每个运行在这 40 条上恰好对 16 条是**构造出来的**，它是样本的性质，不是任何一个 checkpoint 的性质；
  在全量基准上它们分别是 92.93% 和 92.46%。一致性矩阵由两张完整表按 `source_index` 连接而成——
  全部 2985 条上两个都对 2668、只有 Qwen 运行对 106、只有 DeepSeek 运行对 92、两个都错 119——
  构建脚本就是从打包好的表里重算出这些数，并在任何一行的 `id` 或 `subset` 对不上时失败。

**超大记录**（>20 KB，RM-Bench 一个 id 的三条记录合计 >70 KB）会被跳过，改取同一层里的下一个候选。
只有一条例外：`reward_bench` 第 308 条，`mt-bench-easy` 总共只有两条判错里的一条，
44 KB 的一段推理，判决者陷进 `H₂O + H₂O + H₂O…` 之后再也没有给出判定。它被保留下来，
并且是**从中间**截断的——头尾都留着，中间放一句话说明删掉了什么——因为从尾部截会删掉 `<answer>` 标签，
让本来有判定的记录被解析成“没有判定”。而这一条是真的没有，这正是它值得留下的原因。
它列在 `sampling.truncated` 里，带着截断前后的字节数和这条记录的 `record_id`，
好让披露信息能链接到它所说的那条记录。

**两条手挑的记录**在 RewardBench 配额之外另加，作为深链的落点，列在 `sampling.hand_picked` 里，
带上理由、source index、子集，以及外壳 `?record=` 链接所用的 `record_id`；它们和其它记录一样计入
样本准确率。`featured_record` 指的是其中第一条。

**公开发布里有、而这个包里没有的一切。** 一条只说留下了什么的抽样规则，等于没说丢掉了什么，
所以构建会遍历该运行自己的发布目录，要求每个文件必属三者之一：已打包、列在 `sampling.withheld`
（因内容而不发）、或列在 `sampling.excluded`（机械原因而不收）。三者都不是的文件会卡住构建，
直到有人把它是什么写下来。对 `RM-R1-Qwen2.5-Instruct-32B` 来说是 19 个发布文件——15 个打包、
1 个不发、3 个排除，具体见上面英文部分的表。后两条理由本身也是断言，所以也被检查：
构建会去解析那个它称为非法 JSON 的文件、把它称为重复的文件与打包的那份做哈希比对，
并把重新分组的 Harmlessness 文件与不发的原始日志逐条比对。写错理由和不写理由一样会让构建失败。

步长、错误配额、两条手挑记录、不发的那一对，以及上面这份清点，合起来就是面对“精挑细选”这一指控时
的全部辩护，所以它们放在每个包的 `sampling` 里——视图可以把它们渲染出来——而不只是放在这份文件里。

### 脱敏

`reward_bench/score_result/each_small_section_score.json` 的 `model` 字段里有一个内部训练运行名——
一个把训练数据配方拼在路径里的 checkpoint 名。两个发布运行都有。这不是我们可以再分发的东西。

构建会从每一份分数文件里去掉 `model`、`model_type` 和 `chat_template`，然后用三道检查验收。
前两道在写出任何东西之前就中止；第三道在写出之后中止，并删掉刚写的文件：

1. `scores` 下剩余的每一个叶子都必须是**数字**——名字是字符串，所以这一道能在不知道下一个泄漏字段
   叫什么的情况下抓住它。它只报告路径和类型，从不报告值，因为构建日志是个会被到处粘贴的地方；
2. 两个包序列化后的字节都不得匹配 `/wzq016/i` 或 `/filtered_sky/i`，在碰硬盘之前就检查，
   所以失败不会留下任何文件；
3. 写完之后把文件从硬盘读回来再查一遍——如果*这一道*失败，文件会被删除，
   因为检查硬盘上字节的全部意义就在于那些字节正是会被提交的东西。

这三道都通过“把它弄坏”验证过，并对本仓库提交的这两个包重新验证过。
把 `model` 从脱敏列表里去掉会停在第 (1) 道；再把 (1) 废掉会停在 (2)，提交的包在硬盘上原封不动；
把 (1)(2) 都废掉会停在 (3)，那个文件被删除，另一个包早先的产物不受影响。具体报错见英文部分。

`grep -ri "wzq016\|filtered_sky" public/demo-data/` 应当始终没有输出。这是对构建产物的检查，
不是对本仓库源码的检查：上面那两条正则作为守卫模式住在构建脚本里，而名字的一个片段不是配方本身。

有一项排除属于内容问题而非脱敏：`RMB/BoN_set_Harmlessness` 的两条记录不发，
因为其中的次选回答**本身**就是该题目用来测试“是否拒绝”的侮辱性内容，
而这个演示不必把它再发布到一个公开页面上也能讲清它的观点。这件事记录在 `sampling.withheld` 里，
不是悄悄做掉的；同样两条记录按 id 重新分组的那份副本，出于同样理由列在 `sampling.excluded` 里。
把原始文件拖进 AgentLens 就能看到它们。

### 构建校验了什么

每次运行都打印，任何一项不再成立就是致命错误。三段实际输出见英文部分的
“What the build verifies”——脚本打印的就是那一份（英文），这里不再复制一遍，以免两处走样。

RewardBench 那一段，是分子集表格和四个大项方块得以使用榜单名字的理由。`0` 是字面意义上的最大差异，
不是四舍五入出来的：打包的表和发布的分数文件在全部 33 个数值上逐位相同，对照包的两个运行也是如此。
一致性那一段，是把同样的论证交给对照视图：它在这里由两张随包发布的表重算而来，
而对照页在浏览器里读的也是这两张表，所以它画出来的四个格子是基准的，不是它能显示的那 40 条记录的。
也就是说，下面打印出来的那四个数，就是屏幕上的那四个数。

RM-Bench 那一段，是结果表必须完整随包发布的理由。
`eval/RM-Bench/scripts/process_final_result.py` 算出了 `output_path2` 却再没用过它——
`data2` 是从 `output_path3` 读的——于是 `total_dataset_2` 被丢弃，`total_dataset_3` 被数了两遍。
九个矩阵单元格里有三个塌到了邻居上；`hard_acc` 和 `easy_acc` 会动，`normal_acc` 不可能动。
中间那一列复现的是脚本的写法，在八个指标上与随包发布的 `final_result.json` 相差不超过 1e-9——
一旦不成立构建就失败——而正是这个吻合，让右边那一列站得住：两者只差那一行，别无其它。

另外还断言：23 个子集全在，且都被大项映射表命名过——没被命名的子集会从大项分数里无声掉队；
判对和判错的判例都有；三个 RM-Bench 风格文件抽的是同一批 id；两个运行按下标在 `id` 和 `subset`
上对齐；`results` 只可能是 0 或 1；每个发布文件要么打包、要么不发、要么排除且写明理由，
机械性的理由还要拿文件本身重新核对；每个 `coverage` 分母都对应包里真实存在的一张表或一份打包日志；
`notes`、`sampling`、`coverage` 和 `bundle.credit` 里的每一句话都写了两种语言，
两边都不为空、也不是彼此的复制；写出的每个文件都能被解析回来且仍声明自己的格式；整个目录小于 4 MB。

三段里的一切都只凭随包发布的文件就能推导出来，这正是重点：视图是从文件里重算它们，
而不是被告知结果；下载了文件的读者也能做同样的事。

### 署名

包里自带 `bundle.credit`——跟包里其他每一句话一样，是 `{ "en", "zh" }` 一对，
也就是 `Adapter.demos[].credit` 应当使用的那段文字，这样署名跟着文件走，而不是依赖谁记得这份 README。
里面点到的都是数据，两边一模一样：各个运行名、`RM-R1-UIUC/RM-R1` 和 `Apache-2.0`。
长篇署名和 Apache-2.0 条款属于仓库根目录的 `THIRD_PARTY_NOTICES.md`。
