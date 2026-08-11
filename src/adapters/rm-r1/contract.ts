/**
 * What the RM-R1 views need from RM-R1 logs.
 *
 * The four log families RM-R1's harness emits disagree about almost everything —
 * one judgement per record or three, `id` an int or a string, the prompt present
 * or absent. This file is where that ends: everything below is normalised, and
 * the views never branch on which file the data came from.
 *
 * Every field here was read off the real 32B logs, not the paper.
 */

// Type-only, so nothing of the shell's language module runs here: `model.ts` is
// exercised by `node --test` with no DOM, and `Str` is erased at compile time.
import type { Str } from '../../shell/lang'

/** The four log families `eval_one_command.sh` produces. */
export type Benchmark = 'rewardbench' | 'rm-bench' | 'rmb-pairwise' | 'rmb-bon'

export interface Message {
  role: string
  content: string
}

/* --------------------------------------------------------- chain of rubrics */

/**
 * A quoted or summarised span the judge attributed to one side. The judge marks
 * these with `<quote_A>` / `<summary_B>`; showing them next to the response they
 * refer to is the point of the browser.
 */
export interface CorEvidence {
  side: 'A' | 'B'
  kind: 'quote' | 'summary'
  text: string
}

/**
 * A parsed Chain-of-Rubrics judgement.
 *
 * The judge is a language model writing pseudo-XML, so none of this is
 * guaranteed well-formed — the real logs contain doubled closing tags. Every
 * field is optional and `degraded` says when the parse gave up. A view must
 * render `raw` rather than nothing.
 */
export interface CorDocument {
  /** `<type>`: the judge picks a rubric route per question. */
  route: 'chat' | 'reasoning' | 'unknown'
  /** `<rubric>` criteria, one per line as the judge numbered them. */
  criteria: string[]
  /** `<justify>`: why those criteria suit this question. */
  justification?: string
  /** `<solution>`: the reference answer the judge works out first on reasoning items. */
  solution?: string
  /** `<eval>` prose, with the marked spans pulled out. */
  evaluation?: string
  evidence: CorEvidence[]
  /** `<answer>[[A]]</answer>` — which position the judge picked. */
  verdict: 'A' | 'B' | null
  /**
   * Both `[[A]]` and `[[B]]` appeared. RM-R1's own reward function scores this
   * as a failure, so it is worth a badge — but it occurs zero times in the
   * released 32B logs, so a view must not imply it is common.
   */
  ambiguous: boolean
  /** Tags were missing or unbalanced; `raw` is all a view can trust. */
  degraded: boolean
  raw: string
}

/* ----------------------------------------------------------------- verdicts */

export interface Judgement {
  /** `<file>:<index>` — URL-safe, never contains `#`. See the shell's router. */
  id: string
  benchmark: Benchmark
  /** RewardBench subset, RM-Bench domain, or RMB category path. */
  group: string
  /** RewardBench logs carry no prompt; RM-Bench and RMB do. */
  prompt?: string
  /** The response the dataset labels better, and the one it labels worse. */
  chosen: Message[]
  rejected: Message[]
  /**
   * Which slot `chosen` occupied when the judge saw it. The harness shuffles
   * without a seed, so a view that ignores this shows A/B mirrored for half the
   * dataset — and the judge's own prose refers to the shuffled positions.
   */
  chosenShownAs: 'A' | 'B'
  /** null when the harness recorded neither outcome. */
  correct: boolean | null
  cor: CorDocument
  /**
   * RM-Bench only: which of the three response styles this pairing used
   * (0 concise, 1 detailed, 2 detailed + markdown).
   */
  styleIndex?: number
}

/* ------------------------------------------------- RM-Bench 3x3 style matrix */

/**
 * RM-Bench pairs each chosen style against each rejected style. The diagonal is
 * like-for-like; above it the better answer is the plainer one (hard); below it
 * the better answer is also the prettier one (easy).
 */
export interface StyleMatrix {
  /** [chosenStyle][rejectedStyle], accuracy in 0..1. */
  cells: number[][]
  hard: number
  normal: number
  easy: number
}

export interface DomainScores {
  domain: string
  matrix: StyleMatrix
  average: number
}

/**
 * The recomputed RM-Bench summary, and the shipped one when it was dropped in
 * alongside.
 *
 * Why recompute at all: `eval/RM-Bench/scripts/process_final_result.py` opens
 * `output_path3` into `data2` (`output_path2` is computed and never used), so
 * `total_dataset_2` is discarded and `total_dataset_3` is counted twice. Three
 * of the nine cells therefore duplicate their neighbour, which moves `hard_acc`
 * and `easy_acc` while leaving `normal_acc` — read from `total_dataset_1` alone —
 * untouched. That signature is what makes the difference checkable rather than
 * a matter of trust, so a view must show both numbers and never silently
 * replace one with the other.
 */
export interface RmBenchSummary {
  domains: DomainScores[]
  overall: StyleMatrix
  totalAverage: number
  /** Parsed from a dropped `final_result.json`, if present. */
  official?: Record<string, number>
  /**
   * The same computation done the way the shipped script does it. Present only
   * when all three style files are loaded, and used for exactly one claim: that
   * this reproduces the released numbers, so the corrected ones differ by the
   * one line and nothing else.
   */
  reproducedOfficial?: RmBenchSummary
}

/* ----------------------------------------------------------- official scores */

/**
 * What one run's score files say, in that run's own numbers.
 *
 * Never a merge of two runs. Two checkpoints' `main_score.json` files have the
 * same keys and different values, so merging them produces a table that is
 * nobody's — see `RunOfficialScores`.
 */
export interface OfficialScores {
  /** Per-subset accuracy from `each_small_section_score.json`. */
  perSubset?: Record<string, number>
  /** The four headline sections from `main_score.json`. */
  sections?: Record<string, number>
  /** The eight RM-Bench metrics from `final_result.json`. */
  rmBench?: Record<string, number>
  /**
   * Never populated from `model`/`model_type`/`chat_template`. The released
   * score files carry an internal training-run name in `model`; it is not ours
   * to redistribute, so the demo builder drops it and the parser ignores it.
   */
}

/**
 * One run's published scores, with the run named.
 *
 * A published score belongs to the checkpoint that produced it and to nothing
 * else, so it travels with the run's name attached and a view has no way to put
 * one on screen without saying whose it is. Where a run cannot be named — a
 * score file dropped on its own says nothing about which checkpoint wrote it —
 * `run` is `''` and `sources` is all the attribution there is.
 *
 * Two files that state the same slot differently within one run are not
 * resolved by order: the slot is withheld and the model's notes say which two
 * files disagreed.
 */
export interface RunOfficialScores {
  /** The run id the package declares, or `''` for score files dropped loose. */
  run: string
  /** The file names these numbers were read from, in load order. */
  sources: string[]
  scores: OfficialScores
}

/* ---------------------------------------------------------- outcome coverage */

/**
 * One record's outcome, with none of its text.
 *
 * A demo package carries a sample of full traces plus the outcome of *every*
 * record, so a number computed from these is the benchmark's rather than the
 * sample's. That distinction is the whole reason this exists: an accuracy
 * derived from `OutcomeSet` may wear the benchmark's name, and one derived from
 * `RmR1Model.judgements` may not.
 */
export interface OutcomeRecord {
  /**
   * The pairing key: the row's position in the benchmark's own file when the
   * table carries one, else its `id`. Two runs of one benchmark scored the same
   * dataset in the same order, so this is what lines them up — `id` is not
   * unique (the released RewardBench table repeats one across 2,985 rows).
   */
  key: string
  /** The benchmark's own id, as the table states it. Not necessarily unique. */
  id: string
  /** RewardBench subset, RM-Bench domain. */
  group: string
  /** null when the harness recorded no outcome. */
  correct: boolean | null
}

export interface OutcomeTally {
  group: string
  total: number
  correct: number
  /** Outcomes the harness did not record; they are in `total` and not in `correct`. */
  unrecorded: number
}

/**
 * Every record's outcome for one run and one benchmark.
 *
 * RM-Bench asks the same record nine questions (three style files x three
 * slots), and each one is its own row here, with `key` suffixed `:<file>:<slot>`
 * and `id` left as the dataset's. A per-domain tally over those nine is exactly
 * the official per-domain average; the set-wide `correct / total` is not
 * `total_avg_acc`, which is a macro-average over domains.
 */
export interface OutcomeSet {
  /** The run id the package declares, or `''` when it declared none. */
  run: string
  benchmark: Benchmark
  /** The packer's claim that this is every record in the source file. */
  complete: boolean
  /**
   * The judgement-id file labels this run loaded full traces for, so a view can
   * join a set of judgements to the outcome set it is a sample of.
   */
  files: string[]
  total: number
  correct: number
  unrecorded: number
  /** One per `group`, in first-seen order. */
  groups: OutcomeTally[]
  records: OutcomeRecord[]
}

/**
 * Two runs' outcomes over every record both scored — the agreement matrix the
 * compare view draws, computed over the full benchmark rather than the sample.
 *
 * The cell names match the compare view's own, so this is assignable to what it
 * already renders.
 */
export interface OutcomeAgreement {
  /** Records present in both sets. */
  aligned: number
  counts: {
    'both-right': number
    'run1-only': number
    'run2-only': number
    'both-wrong': number
    indeterminate: number
  }
  onlyInRun1: number
  onlyInRun2: number
  /** Determinate pairs only, so the two rates share one denominator. */
  determinate: number
  oneRight: number
  twoRight: number
}

/* ------------------------------------------------ the package's disclosure */

/**
 * How a demo package says it was drawn, carried through from the package
 * verbatim.
 *
 * Nothing below is rephrased: it is the claim a reader has to be able to check
 * the screen against. The fields are optional one by one because this comes out
 * of a dropped file — a package that discloses half of this discloses half, and
 * the half it has still renders.
 *
 * ── Why the prose is `Str` and the identifiers are not ───────────────────────
 * A path, a subset name and a record id are the data's; they render exactly as
 * they arrived. A sentence is not: the sampling rule, the reason a file was held
 * back, the basis a figure is over — those are the disclosure, and a disclosure
 * only half the readership can read is half a disclosure. So every sentence
 * arrives as a pair, and `model.ts` is what guarantees it: a package that wrote
 * one bare string is accepted and that string is shown to both readerships, which
 * is the right answer for somebody else's words — untranslated beats guessed —
 * while this repo's own builder is held to writing both sides.
 */
export interface HandPicked {
  runId?: string
  sourcePath?: string
  sourceIndex?: number
  subset?: string
  /** Why this record was taken on top of the quota. */
  why?: Str
  /** The `?record=` id, so a reader can open exactly what was hand-picked. */
  recordId?: string
}

export interface Withheld {
  sourcePath?: string
  records?: number
  reason?: Str
}

export interface Excluded {
  sourcePath?: string
  reason?: Str
}

/** A record whose text was cut to fit, and the record it was cut from. */
export interface Truncated {
  sourcePath?: string
  sourceIndex?: number
  recordId?: string
  field?: string
  originalBytes?: number
  keptBytes?: number
}

export interface Sampling {
  /** The packer's claim that rebuilding reproduces this package exactly. */
  deterministic?: boolean
  method?: Str
  rules: Str[]
  handPicked: HandPicked[]
  withheld: Withheld[]
  excluded: Excluded[]
  truncated: Truncated[]
}

/**
 * One figure the package expects to be shown, and what it is over.
 *
 * This is the package's own answer to "which number is the benchmark's and which
 * is the sample's", figure by figure. A view that cannot attribute a number has
 * an entry here to render instead of the number.
 */
export interface CoverageEntry {
  figure: Str
  /**
   * The package's own word for what the number is over — "full benchmark",
   * "this sample". Optional because it comes out of a dropped file: an entry
   * that names a figure and no basis is a disclosure with a hole in it, and
   * dropping it would hide the hole as well.
   *
   * The distinction this word draws is the one the whole ledger exists for, so
   * it is a `Str` like the rest: a reader who cannot read "full benchmark"
   * cannot read the ledger. Where a view has to branch on it, branch on `en` —
   * that side is the enumerated vocabulary the builder asserts against.
   */
  basis?: Str
  denominator?: number
  /**
   * Where in the package the figure comes from. A pointer into this file
   * (`runs[].outcome_tables[…]`) with a phrase after it: the pointer is data and
   * is character-identical on both sides, the phrase is not.
   */
  from?: Str
  note?: Str
}

/* -------------------------------------------------------------------- model */

/**
 * One run of one benchmark, and the files its judgements were loaded from.
 *
 * A run is a checkpoint's evaluation, not a file: RM-Bench writes one run into
 * three `total_dataset_N` files and RMB into several directories, and a view
 * that offers those as "Run 1" and "Run 2" is comparing a run with itself. So
 * the grouping key is the run — the id the package declared, or the file itself
 * when nothing declared one — and `files` lists what that run was read from.
 */
export interface LoadedRun {
  /** The run id the package declares, or `''` for files dropped loose. */
  run: string
  benchmark: Benchmark
  /** Every file label this run's judgements were minted from, in load order. */
  files: string[]
  /**
   * The key ids are split on: the first file's label, with RM-Bench's three
   * `total_dataset_N` files collapsed to one `total_dataset_{1,2,3}_…` name,
   * since those three are one run's three pairings.
   */
  fileName: string
  count: number
}

export interface RmR1Model {
  judgements: Judgement[]
  /** Which families are represented, in load order. */
  benchmarks: Benchmark[]
  /** Distinct `group` values, for the filter bar. */
  groups: string[]
  /** Present once all three RM-Bench style files are loaded. */
  rmBench?: RmBenchSummary
  /**
   * Published scores, one entry per run that supplied a score file, in load
   * order. An array and not a map because a view that renders it has to have
   * decided what to do with two of them.
   */
  officialScores: RunOfficialScores[]
  /**
   * The complete outcome of every record, per run and per benchmark, when a
   * package carried one. Empty for a dropped log, which has the records
   * themselves. Anything named after a benchmark comes from here.
   */
  outcomes: OutcomeSet[]
  /**
   * The runs a comparison could be made from: one entry per run and benchmark,
   * and only for a benchmark that has two of them. One run's several files are
   * one run, so a package holding a single checkpoint's whole result directory
   * leaves this empty however many files it packs.
   */
  runs: LoadedRun[]
  /**
   * The package's own sampling disclosure, carried through verbatim. Absent for
   * a dropped log, which is not a sample of anything as far as this adapter
   * knows.
   */
  sampling?: Sampling
  /** The package's figure-by-figure statement of what each number is over. */
  coverage: CoverageEntry[]
  /**
   * Anything the reader must know that the numbers do not say themselves.
   *
   * `Str` and not `string`: these are AgentLens's own words, they are the place
   * the honesty disclosure lives, and a note that exists in one language is a
   * disclosure half the readers cannot read. The type is what stops that from
   * being a matter of diligence. Where a note quotes the data — a file name, a
   * count, a run id — the data is identical on both sides.
   */
  notes: Str[]
}
