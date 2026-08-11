#!/usr/bin/env node
/**
 * Builds the committed RM-R1 demo packages from a local clone of the RM-R1
 * evaluation logs.
 *
 *   node scripts/build-demo-data/rm-r1.mjs [<eval/result dir>]
 *   AGENTLENS_REAL_LOGS=… node scripts/build-demo-data/rm-r1.mjs
 *
 * The argument may be `eval/result`, the repo root, or one run directory under
 * `eval/result` — the same value the test suite wants. Two runs are read either
 * way; a run directory is resolved to its parent.
 *
 * Nothing in the app runs this: the output is committed under
 * `public/demo-data/rm-r1/` and `npm run build` only copies it. It is here so
 * the sampling is auditable rather than a folder of files someone once made.
 *
 * Two rules shape everything below.
 *
 *  1. Reproducible without a seed. Selection is stratified *systematic* sampling
 *     — file order, fixed strides — so there is no RNG whose seed could be tuned
 *     until the sample looked good, and a rebuild is byte-identical.
 *
 *  2. No number that wears a benchmark's name may be the sample's. That is why
 *     the outcome tables are complete — id, group and outcome for all 2985
 *     RewardBench and all 1327 RM-Bench items, no text, ~90 KB each — while only
 *     a sample carries the judge's traces. Every leaderboard-named figure
 *     (per-subset accuracy, the four RewardBench sections, the RM-Bench 3x3
 *     matrix, the run-to-run agreement matrix) is derivable from those tables
 *     alone, and `assertOutcomeTablesReproduceScores` fails the build if the
 *     tables stop reproducing the released score files exactly. Figures that can
 *     only come from the traces — the browser's own list, the sample's accuracy,
 *     anything read out of Chain-of-Rubrics text — are listed under `coverage`
 *     in the package as the sample's, and must be labelled as such on screen.
 *
 * See README.md in this directory for the package layout and the sampling rule
 * in prose; `sampling` and `coverage` inside each package repeat it, so a
 * downloaded file still says how it was made and which of its numbers are whose.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(HERE, '../../public/demo-data/rm-r1')

/**
 * The name before the `@` must be the adapter's registry name: `shell/sniff.ts`
 * routes a declaration by `adapter.name === declared.name`, so `rm-r1-bundle`
 * would warn that no adapter handles this format and fall through to
 * fingerprinting. The `@1` is what `register(..., { formatVersions: ['1'] })`
 * checks against.
 */
const FORMAT = 'rm-r1@1'

/** Public release names, and the directory each run's logs live in. */
const MAIN_RUN = 'RM-R1-Qwen2.5-Instruct-32B'
const OTHER_RUN = 'RM-R1-DeepSeek-Distilled-Qwen-32B'

const SOURCE_REPO = 'https://github.com/RM-R1-UIUC/RM-R1'
const SOURCE_LICENSE = 'Apache-2.0'
const SOURCE_ROOT = 'eval/result'

/* ------------------------------------------------------------------ budget */

/** Hard ceiling for everything written into `public/demo-data/rm-r1/`. */
const TOTAL_BUDGET_BYTES = 4 * 1024 * 1024

/**
 * RewardBench: 10 records per subset, of which up to 4 are ones the judge got
 * wrong. Only 211 of the 2985 items are wrong, so this over-represents mistakes
 * several times over. That is the honest direction to lean — a judgement browser
 * exists to look at the failures — but it does put the sample's accuracy far
 * below the benchmark's. Both numbers go into the package; neither may be shown
 * without the other.
 */
const RB_PER_SUBSET = 10
const RB_INCORRECT_PER_SUBSET = 4

/** RM-Bench: ids per raw `domain` value, split across matrix outcomes. */
const RMB_IDS_PER_DOMAIN = 6
const RMB_MIXED_PER_DOMAIN = 3
const RMB_ALL_CORRECT_PER_DOMAIN = 1

/** Compare package: RewardBench items where the two released runs disagree. */
const CMP_A_RIGHT_B_WRONG = 16
const CMP_A_WRONG_B_RIGHT = 16
const CMP_BOTH_WRONG = 8

/**
 * Records above this are skipped in favour of the next candidate in the same
 * stratum. Only 3 of 2985 RewardBench records are over it — the judge's
 * `max_tokens` is 50000, so a runaway trace reaches 67 KB — and one of them is
 * one of the two mistakes mt-bench-easy contains at all, which is a stratum too
 * small to substitute in. That record is kept and cut; see `cutMiddle`.
 */
const MAX_RECORD_BYTES = 20_000
/** Same idea for RM-Bench, where one id costs three records. Median is ~50 KB. */
const MAX_RM_BENCH_TRIPLE_BYTES = 70_000

/**
 * A sentence in both languages, and the rule for every sentence this builder
 * writes into a package.
 *
 * `sampling`, `coverage` and `notes` are where this package's honesty disclosure
 * ends up on screen — how the sample was drawn, what was held back, which number
 * is the benchmark's and which is this sample's — so a sentence that exists in
 * one language is a disclosure that exists for one half of the readership. The
 * adapter reads `{ en, zh }` and a bare string alike, and `assertBilingual`
 * below refuses to write a package of ours that uses the bare form: the lenient
 * reader is right for somebody else's package, and the strict writer is right
 * for ours.
 *
 * Everything that came out of the logs — run ids, file names, field and tag
 * names, JSON pointers into this package, every count — is the same text in
 * both, because it is data and not language. Translating
 * `Is_Chosen_Answer_Shuffled_toPositionB` would name a field that does not exist.
 */
const bi = (en, zh) => ({ en, zh })

/**
 * Hand-picked on top of the stride quota, because the link in an email has to
 * open onto something legible. Declared in the package, counted separately, and
 * included in the sample accuracy like every other record.
 */
const HAND_PICKED_REWARDBENCH = [
  {
    source_index: 498,
    why: bi(
      'llmbar-adver-neighbor: the rejected answer is fluent and on-topic but is not a card game at all. Four weighted criteria, a justification that names the request it is protecting, and quote/summary spans on both sides — the whole Chain-of-Rubrics shape in about 3 KB.',
      'llmbar-adver-neighbor：被判劣的那个回答通顺、也没跑题，但它根本不是一个纸牌游戏。四条带权重的评分标准、一段点明自己在维护哪条要求的说明，两边都有引用／概述片段——Chain-of-Rubrics 的完整形状，就在大约 3 KB 里。',
    ),
  },
  {
    source_index: 495,
    why: bi(
      'The same subset, a rubric weighted 40/30/20/10 against an answer that gives five tips where three were asked for. Kept as the second deep-link target in case the first reads badly out of context.',
      '同一个子集，一套 40/30/20/10 加权的评分标准，对着一个「问三条建议却给了五条」的回答。留作第二个深链落点，以防第一个脱离上下文读起来不好。',
    ),
  },
]

/**
 * Withheld from the demo package for content reasons, not data reasons. The
 * benchmark asks the judge to reject this text; the demo does not need to
 * republish it on a public page to make its point, and the Helpfulness records
 * show the same log shape. Drop the original file into AgentLens to see them.
 */
const WITHHELD = [
  {
    source_suffix: 'RMB/BoN_set_Harmlessness/log_result/raw_logs.json',
    reason: bi(
      'the rejected response is the demeaning content the item tests refusal of; the RMB log shape is already shown by the Helpfulness records',
      '被判劣的那个回答，正是这道题在测试模型该不该拒绝的贬损内容；RMB 日志长什么样，Helpfulness 的几条记录已经展示过了',
    ),
  },
]

/**
 * Every file in the run's directory that this package does not represent, with
 * the reason. `assertEveryFileAccountedFor` walks the directory and fails if a
 * file matches none of these and is not packed, so "nothing else was quietly
 * left out" is checked against the release rather than asserted from memory —
 * and a new file in a future release stops the build until someone says what it
 * is. `verify` runs where the reason is itself a claim.
 */
const EXCLUDED = [
  {
    match: /^RMB\/BoN_set_Harmlessness\/log_result\/group_by_same_id_logs\.json$/,
    reason: bi(
      'the withheld Harmlessness pair again — the same two records regrouped by id; see sampling.withheld',
      '还是那对被保留不发的 Harmlessness 记录——同样的两条，只是按 id 重新分了组；见 sampling.withheld',
    ),
    verify: (path, dir) => {
      const raw = readFileSync(join(dir, 'RMB/BoN_set_Harmlessness/log_result/raw_logs.json'), 'utf8')
      const grouped = Object.values(JSON.parse(readFileSync(join(dir, path), 'utf8'))).flat()
      return JSON.stringify(grouped) === JSON.stringify(JSON.parse(raw))
        ? null
        : 'holds something other than the records of the withheld raw log, so leaving it out needs its own reason'
    },
  },
  {
    match: /^RMB\/BoN_set_Helpfulness\/log_result\/group_by_same_id_logs\.json$/,
    reason: bi(
      'not valid JSON in the release (a trailing comma), and a demo package has to parse. Drop this file into AgentLens to see the salvage path.',
      '在公开发布里就不是合法 JSON（末尾多了一个逗号），而演示包必须能被解析。把这个文件直接拖进 AgentLens，就能看到抢救解析那条路径。',
    ),
    verify: (path, dir) => {
      try {
        JSON.parse(readFileSync(join(dir, path), 'utf8'))
      } catch {
        return null
      }
      return 'parses as JSON, so the reason given for leaving it out is wrong'
    },
  },
  {
    match: /^RM-Bench\/logs\/final_result\.json$/,
    reason: bi(
      'byte-identical duplicate of RM-Bench/final_result.json, which this package carries',
      '与 RM-Bench/final_result.json 逐字节相同的副本，而这个包已经带了后者',
    ),
    verify: (path, dir) =>
      sha256(readFileSync(join(dir, path))) === sha256(readFileSync(join(dir, 'RM-Bench/final_result.json')))
        ? null
        : 'differs from RM-Bench/final_result.json, so it is not the duplicate this calls it',
  },
]

/* -------------------------------------------------------------- file layout */

const REWARD_BENCH_LOG = 'reward_bench/log_result/logs.json'
const RM_BENCH_LOG = (run, part) => `RM-Bench/logs/total_dataset_${part}_${run}.json`

/**
 * Score files copied into the package. `drop` is the redaction: the released
 * `each_small_section_score.json` carries an internal training-run name under
 * `model` that leaks the data recipe, and it is not ours to redistribute.
 * `assertNoLeaks` re-checks the written bytes rather than trusting this list.
 */
const SCORE_FILES = [
  { path: 'reward_bench/score_result/main_score.json', drop: [] },
  {
    path: 'reward_bench/score_result/each_small_section_score.json',
    drop: ['model', 'model_type', 'chat_template'],
  },
  { path: 'RM-Bench/final_result.json', drop: [] },
  { path: 'RMB/META_RESULT.json', drop: [] },
  { path: 'RMB/Pairwise_set_Helpfulness/score_result/Final_score.json', drop: [] },
  { path: 'RMB/Pairwise_set_Harmlessness/score_result/Final_score.json', drop: [] },
  { path: 'RMB/BoN_set_Helpfulness/score_result/Final_score.json', drop: [] },
  { path: 'RMB/BoN_set_Harmlessness/score_result/Final_score.json', drop: [] },
]

const RMB_LOGS = [
  { path: 'RMB/Pairwise_set_Helpfulness/log_result/logs.json', benchmark: 'rmb-pairwise' },
  { path: 'RMB/Pairwise_set_Harmlessness/log_result/logs.json', benchmark: 'rmb-pairwise' },
  { path: 'RMB/BoN_set_Helpfulness/log_result/raw_logs.json', benchmark: 'rmb-bon' },
  { path: 'RMB/BoN_set_Harmlessness/log_result/raw_logs.json', benchmark: 'rmb-bon' },
]

/* ------------------------------------------------------------------- input */

function resolveSourceDir() {
  const given = process.argv[2] ?? process.env.AGENTLENS_REAL_LOGS
  if (!given) {
    fail(
      'No source directory.\n' +
        '  node scripts/build-demo-data/rm-r1.mjs <path to RM-R1/eval/result>\n' +
        '  AGENTLENS_REAL_LOGS=<path> node scripts/build-demo-data/rm-r1.mjs\n' +
        'The logs are ~130 MB and are not in this repository; clone ' +
        `${SOURCE_REPO} and point at its ${SOURCE_ROOT} directory.`,
    )
  }
  const root = resolve(given)
  // Three spellings of the same place, because the variable already has a
  // meaning: everywhere else in this repo AGENTLENS_REAL_LOGS is one *run*
  // directory (the test suite takes its parent to find the sibling run), while
  // this script needs both runs and so wants the directory above. Accepting the
  // run directory, `eval/result` and the repo root means one variable can be set
  // once and be right for the tests and for the builder, instead of meaning two
  // different paths in two documents.
  const candidates = [root, join(root, SOURCE_ROOT), dirname(root)]
  for (const dir of candidates) {
    if (existsSync(join(dir, MAIN_RUN, REWARD_BENCH_LOG))) return dir
  }
  fail(
    `Could not find ${MAIN_RUN}/${REWARD_BENCH_LOG} under any of:\n` +
      candidates.map((c) => `  ${c}`).join('\n'),
  )
}

function readJson(dir, relative) {
  const path = join(dir, relative)
  if (!existsSync(path)) fail(`Missing input: ${path}`)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`Could not parse ${path}: ${error.message}`)
  }
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

/**
 * Which of the run's released files this package represents, and why each of the
 * rest is absent. A sampling defence that only lists what was kept says nothing
 * about what was dropped, so this walks the run's own directory: every file is
 * either packed, withheld with a reason, or matched by `EXCLUDED`, and anything
 * else stops the build.
 */
function fileAccounting(dir, run, packedPaths) {
  const root = join(dir, run)
  const all = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name).slice(root.length + 1))
    .sort()

  const packed = new Set(packedPaths)
  const withheld = new Set(WITHHELD.map((one) => one.source_suffix))
  const excluded = []
  for (const path of all) {
    if (packed.has(path) || withheld.has(path)) continue
    const rule = EXCLUDED.find((one) => one.match.test(path))
    if (!rule) {
      fail(
        `${run}/${path} is in the release and in neither the package nor EXCLUDED. ` +
          'Pack it or say why it is left out — an undeclared omission is the thing sampling.excluded exists to rule out.',
      )
    }
    const wrong = rule.verify?.(path, root)
    // `.en` because this is a build error on a developer's terminal, not a line
    // of the package. The pair is what ships.
    if (wrong) fail(`${run}/${path} is excluded because it ${rule.reason.en}, but it ${wrong}`)
    excluded.push({ source_path: `${run}/${path}`, reason: rule.reason })
  }
  if (all.length !== packed.size + withheld.size + excluded.length) {
    fail(`${run}: ${all.length} released files, ${packed.size} packed, ${withheld.size} withheld, ${excluded.length} excluded`)
  }
  return { released: all.length, packed: packed.size, excluded }
}

function fail(message) {
  process.stderr.write(`build-demo-data/rm-r1: ${message}\n`)
  process.exit(1)
}

/* ---------------------------------------------------------------- sampling */

/**
 * Systematic sampling: `quota` items spread evenly across `items` in file order,
 * starting half a stride in so the first and last item are not privileged.
 * `acceptable` rejects candidates (oversize records); a rejected candidate walks
 * forward through the stratum rather than being replaced by a neighbour of the
 * previous pick, which keeps the spread.
 */
function stride(items, quota, acceptable = () => true) {
  const total = items.length
  const want = Math.min(quota, total)
  const taken = new Set()
  for (let k = 0; k < want; k++) {
    const start = Math.floor(((k + 0.5) * total) / want)
    let chosen = -1
    for (let step = 0; step < total && chosen === -1; step++) {
      const candidate = (start + step) % total
      if (!taken.has(candidate) && acceptable(items[candidate])) chosen = candidate
    }
    // Every remaining candidate is oversize: take one anyway and let the caller
    // truncate it, so a stratum never silently shrinks.
    for (let step = 0; step < total && chosen === -1; step++) {
      const candidate = (start + step) % total
      if (!taken.has(candidate)) chosen = candidate
    }
    if (chosen === -1) break
    taken.add(chosen)
  }
  return [...taken].sort((a, b) => a - b).map((i) => items[i])
}

const bytes = (value) => Buffer.byteLength(JSON.stringify(value))

/** Group `items` by `key`, keeping first-seen key order. */
function groupBy(items, key) {
  const groups = new Map()
  for (const item of items) {
    const k = key(item)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(item)
  }
  return groups
}

/* ------------------------------------------------------- truncation marking */

const truncations = []

/**
 * Last resort when a stratum has nothing smaller. The record keeps its shape and
 * gains one field, so a view can say the text is cut instead of showing a
 * mangled trace as if it were the model's whole answer. `field` is the judge's
 * output — `answers` on RewardBench and RMB, `output` (three of them) on
 * RM-Bench — because that is the only thing in a record long enough to matter.
 */
function truncateField(record, field, budget, sourcePath, sourceIndex) {
  const original = record[field]
  const isList = Array.isArray(original)
  if (!isList && typeof original !== 'string') return record
  const texts = isList ? original : [original]
  const keep = Math.max(0, Math.floor(budget / texts.length) - 2000)
  const before = texts.reduce((sum, text) => sum + Buffer.byteLength(text), 0)
  if (before <= keep * texts.length) return record

  const cut = texts.map((text) => cutMiddle(text, keep))
  truncations.push({
    source_path: sourcePath,
    source_index: sourceIndex,
    // The shell's `?record=` id, so a view can link the disclosure to the record
    // it is about instead of describing a cut the reader cannot go and look at.
    record_id: `${sourcePath.slice(sourcePath.lastIndexOf('/') + 1)}:${sourceIndex}`,
    field,
    original_bytes: before,
    kept_bytes: cut.reduce((sum, text) => sum + Buffer.byteLength(text), 0),
  })
  return { ...record, [field]: isList ? cut : cut[0], agentlens_truncated: field }
}

/**
 * Cut out of the middle, not off the end. The judge's verdict is the last thing
 * it writes — `<answer>[[A]]</answer>` — so a tail cut would leave a record whose
 * parse says "no verdict" when the source clearly has one, which is a worse lie
 * than a visible gap. The gap carries its own sentence rather than an ellipsis,
 * because this text is rendered as the model's own output.
 */
function cutMiddle(text, keep) {
  const buffer = Buffer.from(text)
  if (buffer.length <= keep) return text
  const head = Math.floor(keep * 0.7)
  const tail = keep - head
  const removed = buffer.length - keep
  const mark = `\n\n[… ${removed} bytes removed here by the AgentLens demo builder; the head and tail of the judge's output are kept …]\n\n`
  return utf8(buffer.subarray(0, head)) + mark + utf8(buffer.subarray(buffer.length - tail))
}

/** A byte slice can land inside a code point; drop the broken edges. */
const utf8 = (buffer) => buffer.toString('utf8').replace(/^�+|�+$/g, '')

/* ------------------------------------------------------------ RewardBench */

function rewardBenchSample(records) {
  const indexed = records.map((value, source_index) => ({ value, source_index }))
  const picked = []

  for (const [, subsetItems] of groupBy(indexed, (item) => item.value.subset)) {
    const wrong = subsetItems.filter((item) => item.value.results === 0)
    const right = subsetItems.filter((item) => item.value.results !== 0)
    const small = (item) => bytes(item.value) <= MAX_RECORD_BYTES
    const takeWrong = stride(wrong, RB_INCORRECT_PER_SUBSET, small)
    const takeRight = stride(right, RB_PER_SUBSET - takeWrong.length, small)
    picked.push(...takeWrong, ...takeRight)
  }

  for (const { source_index, why } of HAND_PICKED_REWARDBENCH) {
    if (picked.some((item) => item.source_index === source_index)) continue
    picked.push({ value: records[source_index], source_index, hand_picked: why })
  }

  picked.sort((a, b) => a.source_index - b.source_index)
  return picked
}

/**
 * id, subset and outcome for every record — the dashboard's real denominator.
 *
 * `run_id` is on the table and not only on the run around it because a compare
 * package ships two of these, identical in shape and nearly identical in
 * content, and a figure that cannot name the run it belongs to may not be shown
 * at all. `align_on` is `source_index` rather than `id` because RewardBench's
 * `id` is not unique: 3692 appears twice in these logs (once under `donotanswer`
 * and once under `hep-python`). Position in the source file is unique, and the
 * build asserts the two released runs agree on `id` and `subset` at every
 * position before it packs them.
 */
function rewardBenchOutcomes(records, sourcePath, runId) {
  return {
    run_id: runId,
    source_path: sourcePath,
    benchmark: 'rewardbench',
    complete: true,
    count: records.length,
    align_on: 'source_index',
    columns: ['source_index', 'id', 'subset', 'results', 'Is_Chosen_Answer_Shuffled_toPositionB'],
    rows: records.map((r, i) => [i, r.id, r.subset, r.results, r.Is_Chosen_Answer_Shuffled_toPositionB]),
  }
}

/* ---------------------------------------------------------------- RM-Bench */

/**
 * One id at a time, taking that id from all three style files. The 3x3 matrix is
 * assembled across the files (`result` of file 1 is the diagonal, files 2 and 3
 * the off-diagonals), so an id present in only one file cannot contribute a cell.
 */
function rmBenchSample(parts) {
  const [d1, d2, d3] = parts
  const ids = d1.map((_, i) => i)
  for (const i of ids) {
    if (d1[i].id !== d2[i].id || d1[i].id !== d3[i].id) {
      fail(`RM-Bench files disagree at index ${i}: ${d1[i].id} / ${d2[i].id} / ${d3[i].id}`)
    }
  }

  const correctCells = (i) =>
    [...d1[i].result, ...d2[i].result, ...d3[i].result].reduce((sum, r) => sum + r, 0)
  const tripleBytes = (i) => bytes(d1[i]) + bytes(d2[i]) + bytes(d3[i])
  const small = (i) => tripleBytes(i) <= MAX_RM_BENCH_TRIPLE_BYTES

  const picked = []
  // Grouping on the raw `domain` keeps `safety-refuse` and `safety-response`
  // apart here even though the official script folds them with startswith().
  for (const [, domainIds] of groupBy(ids, (i) => d1[i].domain)) {
    const mixed = domainIds.filter((i) => correctCells(i) > 0 && correctCells(i) < 9)
    const allRight = domainIds.filter((i) => correctCells(i) === 9)
    const allWrong = domainIds.filter((i) => correctCells(i) === 0)
    const take = [
      ...stride(mixed, RMB_MIXED_PER_DOMAIN, small),
      ...stride(allRight, RMB_ALL_CORRECT_PER_DOMAIN, small),
    ]
    // Whatever the quota did not spend goes to items the judge got wrong on
    // every style pairing, then back to mixed ones.
    const rest = RMB_IDS_PER_DOMAIN - take.length
    take.push(...stride(allWrong, rest, small))
    const short = RMB_IDS_PER_DOMAIN - take.length
    if (short > 0) {
      take.push(...stride(mixed.filter((i) => !take.includes(i)), short, small))
    }
    picked.push(...take)
  }
  picked.sort((a, b) => a - b)
  return picked
}

function rmBenchOutcomes(parts, sourcePaths, runId) {
  const [d1, d2, d3] = parts
  return {
    run_id: runId,
    source_paths: sourcePaths,
    benchmark: 'rm-bench',
    complete: true,
    count: d1.length,
    align_on: 'source_index',
    columns: ['source_index', 'id', 'domain', 'result_1', 'result_2', 'result_3'],
    rows: d1.map((r, i) => [i, r.id, r.domain, r.result, d2[i].result, d3[i].result]),
  }
}

/* ------------------------------------------------------------------ scores */

function scoreEntry(dir, run, spec) {
  const value = readJson(dir, join(run, spec.path))
  const dropped = []
  const strip = (object) => {
    const copy = {}
    for (const [key, entry] of Object.entries(object)) {
      if (spec.drop.includes(key)) {
        dropped.push(key)
        continue
      }
      copy[key] = entry
    }
    return copy
  }
  const cleaned = Array.isArray(value) ? value.map(strip) : strip(value)
  // `run_id` rather than "parse it back out of source_path": an official score
  // belongs to exactly one checkpoint, and a compare package packs two files of
  // the same name. A panel that cannot say whose number it is shows nothing.
  return { run_id: run, source_path: `${run}/${spec.path}`, dropped_keys: dropped, value: cleaned }
}

/**
 * Redaction check that does not depend on knowing the next leaked field's name:
 * every leaf under `scores` must be a number. Names are strings; accuracies are
 * not.
 */
function assertScoresAreNumbers(entries) {
  const walk = (node, path) => {
    if (typeof node === 'number') return
    if (Array.isArray(node)) return node.forEach((item, i) => walk(item, `${path}[${i}]`))
    if (node && typeof node === 'object') {
      return Object.entries(node).forEach(([key, item]) => walk(item, `${path}.${key}`))
    }
    // The value is not echoed. This assert fires precisely when the thing at
    // `path` may be the name we are trying not to publish, and a build log is a
    // place things get pasted from.
    fail(`score file ${path} still holds a ${typeof node} where every leaf must be a number — add it to \`drop\``)
  }
  for (const entry of entries) walk(entry.value, entry.source_path)
}

/* ------------------------------------------------------------- assembly */

function logEntry({ runId, sourcePath, benchmark, items, sourceTotal, extra = {} }) {
  const rmBench = benchmark === 'rm-bench'
  const field = rmBench ? 'output' : 'answers'
  const budget = rmBench ? MAX_RM_BENCH_TRIPLE_BYTES / 3 : MAX_RECORD_BYTES
  const records = items.map((item) =>
    truncateField(item.value, field, budget, sourcePath, item.source_index),
  )
  return {
    run_id: runId,
    source_path: sourcePath,
    benchmark,
    source_total: sourceTotal,
    sampled: records.length,
    source_indices: items.map((item) => item.source_index),
    ...extra,
    records,
  }
}

function accuracyOf(values) {
  if (values.length === 0) return null
  return values.reduce((sum, v) => sum + v, 0) / values.length
}

/* ------------------------------------- RewardBench, from the outcome table */

/**
 * RewardBench's own grouping of its 23 subsets into the four leaderboard
 * sections. Nothing here is guessed: `assertOutcomeTablesReproduceScores` makes
 * the build fail unless this mapping and the recipe below reproduce the released
 * `main_score.json` and `each_small_section_score.json` to 1e-12, which is what
 * licenses the dashboard showing a section score computed here under the
 * section's own name.
 */
const REWARD_BENCH_SECTIONS = {
  Chat: ['alpacaeval-easy', 'alpacaeval-length', 'alpacaeval-hard', 'mt-bench-easy', 'mt-bench-med'],
  'Chat Hard': [
    'mt-bench-hard',
    'llmbar-natural',
    'llmbar-adver-neighbor',
    'llmbar-adver-GPTInst',
    'llmbar-adver-GPTOut',
    'llmbar-adver-manual',
  ],
  Safety: [
    'refusals-dangerous',
    'refusals-offensive',
    'xstest-should-refuse',
    'xstest-should-respond',
    'donotanswer',
  ],
  Reasoning: ['math-prm', 'hep-cpp', 'hep-go', 'hep-java', 'hep-js', 'hep-python', 'hep-rust'],
}

/**
 * `rewardbench/constants.py`'s EXAMPLE_COUNTS — the benchmark's own per-subset
 * weights, which is how RewardBench itself forms a section score. They match the
 * row counts in these logs everywhere except `math-prm`, which has 447 rows and
 * weighs 984. That single difference is the whole reason a section score is not
 * plain accuracy, and it is why both formulations are checked below rather than
 * one being declared the right one.
 */
const REWARD_BENCH_EXAMPLE_COUNTS = {
  'alpacaeval-easy': 100,
  'alpacaeval-length': 95,
  'alpacaeval-hard': 95,
  'mt-bench-easy': 28,
  'mt-bench-med': 40,
  'mt-bench-hard': 37,
  'math-prm': 984,
  'refusals-dangerous': 100,
  'refusals-offensive': 100,
  'llmbar-natural': 100,
  'llmbar-adver-neighbor': 134,
  'llmbar-adver-GPTInst': 92,
  'llmbar-adver-GPTOut': 47,
  'llmbar-adver-manual': 46,
  'xstest-should-refuse': 154,
  'xstest-should-respond': 250,
  donotanswer: 136,
  'hep-cpp': 164,
  'hep-go': 164,
  'hep-java': 164,
  'hep-js': 164,
  'hep-python': 164,
  'hep-rust': 164,
}

/**
 * The recipe the released files were made with, recovered by matching them.
 *
 * Chat, Chat Hard and Safety are plain accuracy over every record in the
 * section. Reasoning is not, and that carve-out is the whole subtlety: it is the
 * mean of math-prm's accuracy and the mean of the six hep-* accuracies, so its
 * 447 maths rows weigh as much as all 984 code items together. Plain accuracy
 * over Reasoning's 1431 rows gives 0.96016771 where the released file says
 * 0.95211300 — off by 0.81 of a point, which is why the recipe is asserted
 * rather than assumed, and why nothing here may say the two formulations agree
 * on a plain reading of the section.
 *
 * Three things are returned rather than one, because they are three different
 * claims and the package quotes all three:
 *   sections          the recipe above — what the released file states.
 *   sectionsWeighted  EXAMPLE_COUNTS applied to the 23 per-subset accuracies.
 *                     Equals `sections` on a complete table, and on Reasoning it
 *                     does so by construction: 984 of 1968 is exactly half, so
 *                     the weighting *is* "half math-prm, half the hep mean".
 *   sectionsPlain     plain accuracy over the section's records, for all four.
 *                     Three of them are the section score; Reasoning's is not,
 *                     and the coverage note quotes it as the number that is not.
 */
function rewardBenchFromTable(table) {
  const col = Object.fromEntries(table.columns.map((name, i) => [name, i]))
  const right = new Map()
  const total = new Map()
  for (const row of table.rows) {
    const subset = row[col.subset]
    right.set(subset, (right.get(subset) ?? 0) + row[col.results])
    total.set(subset, (total.get(subset) ?? 0) + 1)
  }
  const perSubset = {}
  for (const [subset, n] of total) perSubset[subset] = right.get(subset) / n

  const sectionsPlain = {}
  const sectionRows = {}
  for (const [section, subsets] of Object.entries(REWARD_BENCH_SECTIONS)) {
    const hits = subsets.reduce((sum, s) => sum + right.get(s), 0)
    const seen = subsets.reduce((sum, s) => sum + total.get(s), 0)
    sectionsPlain[section] = hits / seen
    sectionRows[section] = seen
  }

  const sections = {}
  for (const [section, subsets] of Object.entries(REWARD_BENCH_SECTIONS)) {
    if (section === 'Reasoning') {
      const hep = subsets.filter((s) => s.startsWith('hep'))
      sections[section] = mean([perSubset['math-prm'], mean(hep.map((s) => perSubset[s]))])
      continue
    }
    sections[section] = sectionsPlain[section]
  }

  const sectionsWeighted = {}
  const sectionWeight = {}
  for (const [section, subsets] of Object.entries(REWARD_BENCH_SECTIONS)) {
    let weighted = 0
    let weight = 0
    for (const subset of subsets) {
      const count = REWARD_BENCH_EXAMPLE_COUNTS[subset]
      if (count === undefined) fail(`no EXAMPLE_COUNTS weight for subset ${subset}`)
      weighted += perSubset[subset] * count
      weight += count
    }
    sectionsWeighted[section] = weighted / weight
    sectionWeight[section] = weight
  }

  return {
    perSubset,
    sections,
    sectionsWeighted,
    sectionsPlain,
    sectionRows,
    sectionWeight,
    mathPrmRows: total.get('math-prm'),
    mathPrmWeight: REWARD_BENCH_EXAMPLE_COUNTS['math-prm'],
    avg_Result_each_section: mean(Object.values(sections)),
    absoluate_Result: table.rows.reduce((sum, row) => sum + row[col.results], 0) / table.rows.length,
  }
}

/**
 * The claim in `sampling.rules` and in the README — that every leaderboard-named
 * number is the benchmark's — is only worth making if it is checked. This checks
 * it against the run's own released score files and stops the build on any
 * disagreement, so a package can never ship saying something the numbers inside
 * it do not support.
 *
 * Two formulations are checked per section, and `sectionsPlain` is deliberately
 * *not* one of them: over Reasoning it disagrees with the released file by 0.81
 * of a point, so checking it would fail this build and stating that it passes
 * would be the coverage note claiming a check nothing performs. It is computed
 * and carried so the note can quote the number it is not.
 */
function assertOutcomeTablesReproduceScores(run) {
  const table = run.outcome_tables.find((t) => t.benchmark === 'rewardbench')
  if (!table) return null
  const find = (suffix) => run.scores.find((s) => s.source_path.endsWith(suffix))?.value
  const each = find('reward_bench/score_result/each_small_section_score.json')
  const main = find('reward_bench/score_result/main_score.json')
  const got = rewardBenchFromTable(table)

  // A subset the sections do not name would be silently dropped from every
  // section score, and the totals would still look plausible.
  const named = new Set(Object.values(REWARD_BENCH_SECTIONS).flat())
  const seen = Object.keys(got.perSubset)
  const unnamed = seen.filter((s) => !named.has(s))
  if (unnamed.length > 0 || seen.length !== named.size) {
    fail(
      `${run.run_id}: the outcome table holds ${seen.length} subsets and the section map names ${named.size}` +
        (unnamed.length > 0 ? `; unmapped: ${unnamed.join(', ')}` : ''),
    )
  }

  let worst = 0
  let checks = 0
  const check = (label, mine, theirs) => {
    if (typeof theirs !== 'number') fail(`${run.run_id}: no released value for ${label} to check against`)
    const diff = Math.abs(mine - theirs)
    worst = Math.max(worst, diff)
    checks += 1
    if (diff > 1e-12) {
      fail(
        `${run.run_id}: the complete outcome table gives ${label} = ${mine}, the released score file says ${theirs}. ` +
          'The package may not claim its per-subset and section numbers are the benchmark\'s — nothing was written.',
      )
    }
  }
  if (each) for (const [subset, value] of Object.entries(got.perSubset)) check(subset, value, each[subset])
  if (main) {
    for (const [section, value] of Object.entries(got.sections)) check(section, value, main[section])
    for (const [section, value] of Object.entries(got.sectionsWeighted)) {
      check(`${section} (EXAMPLE_COUNTS weighting)`, value, main[section])
    }
    check('avg_Result_each_section', got.avg_Result_each_section, main.avg_Result_each_section)
    check('absoluate_Result', got.absoluate_Result, main.absoluate_Result)
  }
  return { subsets: Object.keys(got.perSubset).length, checked: checks, worst, ...got }
}

/** Both-right / one-only / both-wrong over every aligned item, not over the sample. */
function agreementFromTables(tableA, tableB) {
  const colA = Object.fromEntries(tableA.columns.map((n, i) => [n, i]))
  const colB = Object.fromEntries(tableB.columns.map((n, i) => [n, i]))
  const byIndex = new Map(tableB.rows.map((row) => [row[colB.source_index], row]))
  const cells = { both_right: 0, a_only: 0, b_only: 0, both_wrong: 0 }
  let aligned = 0
  for (const rowA of tableA.rows) {
    const rowB = byIndex.get(rowA[colA.source_index])
    if (!rowB) continue
    if (rowA[colA.id] !== rowB[colB.id] || rowA[colA.subset] !== rowB[colB.subset]) {
      fail(`the two outcome tables disagree at source_index ${rowA[colA.source_index]} — they are not the same items`)
    }
    aligned += 1
    const a = rowA[colA.results] === 1
    const b = rowB[colB.results] === 1
    if (a && b) cells.both_right += 1
    else if (a) cells.a_only += 1
    else if (b) cells.b_only += 1
    else cells.both_wrong += 1
  }
  return { aligned, ...cells }
}

const SAMPLING_RULES = [
  bi(
    'No random number generator is used. Within each stratum the sample is systematic: `quota` items spread evenly across the stratum in the source file\'s own order, so rebuilding the package reproduces it byte for byte.',
    '不使用随机数发生器。每一层内部都是系统抽样：按源文件自身的顺序，把 `quota` 条均匀地铺在这一层上，所以重新构建这个包，得到的结果逐字节一致。',
  ),
  bi(
    `RewardBench: ${RB_PER_SUBSET} records from each of the 23 subsets, of which up to ${RB_INCORRECT_PER_SUBSET} are judgements the model got wrong. Wrong judgements are therefore over-represented; the sample's accuracy is well below the benchmark's and the two are reported side by side.`,
    `RewardBench：23 个子集各取 ${RB_PER_SUBSET} 条，其中最多 ${RB_INCORRECT_PER_SUBSET} 条是模型判错的判例。所以错误判例是被超采的；样本的准确率远低于基准上的准确率，两个数并排给出。`,
  ),
  bi(
    `RM-Bench: ${RMB_IDS_PER_DOMAIN} ids from each of the five raw domain values, split across ids the judge got right on all nine style pairings, wrong on all nine, and mixed. Each sampled id is taken from all three style files, because a 3x3 cell needs all three.`,
    `RM-Bench：五个原始 domain 值各取 ${RMB_IDS_PER_DOMAIN} 个 id，在「九个风格配对全对」「全错」「有对有错」三类之间分配。每个选中的 id 都从三个风格文件里各取一条，因为一个 3x3 单元格需要三个文件都在。`,
  ),
  bi(
    `Records over ${MAX_RECORD_BYTES} bytes (RM-Bench: ${MAX_RM_BENCH_TRIPLE_BYTES} bytes for the three files together) are passed over in favour of the next candidate in the same stratum. Only when a stratum has no smaller candidate is a record kept, and then the middle of the judge's output is removed — head and tail stay, so the verdict tag survives — a sentence saying so is left in the gap, and the record carries an "agentlens_truncated" field naming the field that was cut.`,
    `超过 ${MAX_RECORD_BYTES} 字节的记录（RM-Bench：三个文件合计超过 ${MAX_RM_BENCH_TRIPLE_BYTES} 字节）会被跳过，改取同一层里的下一个候选。只有当这一层再没有更小的候选时才留下这条记录，并删掉评审输出的中间部分——头尾都保留，所以判定标签不会丢——空缺处留一句话说明这件事，记录本身也带上 "agentlens_truncated" 字段，写明被截断的是哪个字段。`,
  ),
  bi(
    'Outcome tables are not sampled at all: source position, id, group and outcome for every record in every source log are included, tagged with the run they belong to. Per-subset accuracy, the four RewardBench section scores, the RM-Bench 3x3 style matrix and its four metrics are computed from those tables and are therefore the full benchmark\'s numbers, not this sample\'s. The build recomputes the run\'s own released score files from the packed tables and refuses to write a package that does not reproduce them exactly.',
    '结果表完全不抽样：每一份源日志里每一条记录的源位置、id、分组和结果都在其中，并标明属于哪个运行。分子集准确率、RewardBench 的四个大项分数、RM-Bench 的 3x3 风格矩阵及其四个指标，都是从这些表算出来的，因此是整个基准的数字，不是这份样本的。构建时会用打包好的表重算该运行自己发布的分数文件，重算不出来就拒绝写出这个包。',
  ),
  bi(
    'What the outcome tables cannot give is anything that needs the judge\'s text: the browser\'s list of judgements, the sample\'s own accuracy, and every figure read out of a Chain-of-Rubrics trace. Those are the sample\'s and are labelled as the sample\'s. `coverage` in this package names every figure the demo shows, one at a time, with the denominator it is over and where in this file it comes from — a figure whose basis is "this sample" may not be shown under a benchmark\'s or a section\'s name.',
    '结果表给不了的，是任何需要评审文本的东西：浏览器里的判例列表、样本自身的准确率，以及从 Chain-of-Rubrics 推理里读出的每一个数字。这些属于这份样本，也以这份样本的名义标注。这个包里的 `coverage` 逐条列出演示会显示的每个数字、各自的分母，以及在这个文件里从哪来——basis 是「这份样本」的数字，不许挂在某个基准或某个大项的名字下。',
  ),
  bi(
    'Two RewardBench records are hand-picked on top of the quota as deep-link targets, listed under sampling.hand_picked with the reason and the record id the deep link uses. They are counted in the sample accuracy like any other record.',
    '有两条 RewardBench 记录是在配额之外手挑的，用作深链的落点，列在 sampling.hand_picked 里，附上挑选理由和深链所用的记录 id。它们和其他记录一样计入样本准确率。',
  ),
  bi(
    'One released log is withheld for content reasons rather than data reasons, and is listed under sampling.withheld with the file it came from, how many records it holds and why. Every other file in the run\'s released directory is either represented in this package or listed under sampling.excluded with the reason it is not: the build walks that directory and stops if a file appears in neither list, so an omission cannot go undeclared.',
    '有一份公开日志出于内容原因、而不是数据原因被保留不发，列在 sampling.withheld 里，写明它来自哪个文件、有多少条记录、以及为什么。该运行公开目录里的其余每一个文件，要么在这个包里有代表，要么列在 sampling.excluded 里并写明不收的理由：构建会遍历那个目录，只要有文件两边都不在就停下，所以遗漏没法不声明。',
  ),
]

const NOTES = [
  bi(
    'RM-R1 released these logs; AgentLens only reads them. Numbers shown here are recomputed from this package unless a panel says they came from a shipped score file: a figure that carries a benchmark\'s or a section\'s name is computed from the complete outcome tables and is that benchmark\'s, and a figure that can only come from the sampled traces is shown as this sample\'s and named as this sample\'s. "coverage" in this package lists them figure by figure with the denominator each is over.',
    '这些日志是 RM-R1 发布的，AgentLens 只负责读。除非某个面板写明数字来自随包发布的分数文件，否则屏幕上的数字都是从这个包里重算的：挂着基准或大项名字的数字来自完整的结果表，就是那个基准的数字；只能从抽样到的推理文本里读出来的数字，则以“这份样本”的名义显示，也这么标着。包里的 "coverage" 逐个列出这些数字，以及每个数字各自的分母。',
  ),
  bi(
    'The counts quoted in the notes below — how many records emit no <answer> tag, how many put both [[A]] and [[B]] inside one, how many judgements are wrong — were measured by the builder over the whole source log at build time. They are the full run\'s counts, but only the sample\'s traces travel in this package, so they cannot be re-derived from it.',
    '下面几条注记里的计数——多少条记录没有写出 <answer> 标签、多少条把 [[A]] 和 [[B]] 同时塞进一个标签里、多少条判错了——是构建脚本在构建时对整份源日志数出来的。它们是整个运行的计数，但这个包里只带了样本的推理文本，所以没法从这个包本身再数一遍。',
  ),
  bi(
    'The released score files carry an internal training-run name under "model"; the demo builder drops "model", "model_type" and "chat_template" and asserts they are gone. Only the public release name of the run is kept.',
    '公开的分数文件在 "model" 字段里写着一个内部训练运行名；构建脚本会去掉 "model"、"model_type" 和 "chat_template"，并断言它们确实不在了。留下的只有这个运行公开发布时的名字。',
  ),
  bi(
    'The harness shuffles which side the chosen answer is shown as, and the judge\'s prose refers to those shuffled positions. Is_Chosen_Answer_Shuffled_toPositionB is carried on every record for that reason.',
    '评测脚本会打乱优选回答出现在哪一边，而评审模型写下的话说的正是打乱之后的位置。每条记录都带着 Is_Chosen_Answer_Shuffled_toPositionB，就是为了这个。',
  ),
]

const RMB_NOTES = [
  bi(
    'RMB records here include a Harmlessness pair about suicide method; both responses are refusals and both name crisis resources. It is in the benchmark and is shown as the benchmark has it.',
    '这里的 RMB 记录里有一对 Harmlessness 样本涉及自杀方式；两个回答都是拒答，也都给出了危机求助资源。它本来就在这个基准里，这里按基准原本的样子显示。',
  ),
  bi(
    'One RMB file in the release, RMB/BoN_set_Helpfulness/log_result/group_by_same_id_logs.json, is not valid JSON (a trailing comma). It is not in this package — a demo package has to parse — so drop that file into AgentLens to see the salvage path.',
    '公开的 RMB 文件里有一个 RMB/BoN_set_Helpfulness/log_result/group_by_same_id_logs.json 不是合法 JSON（末尾多了一个逗号）。它不在这个包里——演示包必须能被解析——想看抢救解析那条路径，把那个文件直接拖进 AgentLens。',
  ),
]

/**
 * Claims the package makes about the source logs, each measured here rather than
 * remembered and written into `notes` with the count it came from. If one stops
 * being true the build stops: a note that is quietly wrong is worse than no note.
 *
 * The `[[A]]`/`[[B]]` pair is counted twice on purpose. Scanning the whole trace
 * finds two records in the DeepSeek run, and both are the judge quoting the
 * instruction it was given ("output either [[A]] or [[B]]") while it spirals —
 * not two verdicts. Scanning only inside `<answer>` spans finds none in either
 * run. A badge built on the loose count is a false badge.
 */
function measuredNotes(runId, records, sample) {
  const outcomes = [...new Set(records.map((r) => r.results))].sort()
  if (outcomes.join(',') !== '0,1') {
    fail(`RewardBench "results" holds ${JSON.stringify(outcomes)} — the tie note below is wrong`)
  }
  const answerSpans = (text) => [...text.matchAll(/<answer>([\s\S]*?)<\/answer>/g)].map((m) => m[1])
  const bothTokens = (text) => text.includes('[[A]]') && text.includes('[[B]]')

  const loose = records.filter((r) => bothTokens(r.answers)).length
  const strict = records.filter((r) => answerSpans(r.answers).some(bothTokens)).length
  const noVerdict = records.filter((r) => answerSpans(r.answers).length === 0).length
  const wrong = records.filter((r) => r.results === 0).length
  const sampleWrong = sample.filter((record) => record.results === 0).length

  return [
    bi(
      `RewardBench "results" is 1 or 0 in these logs: no tie value appears in any of ${runId}'s ${records.length} records.`,
      `在这些日志里，RewardBench 的 "results" 只有 1 和 0：${runId} 的 ${records.length} 条记录里没有出现表示平局的值。`,
    ),
    bi(
      `${strict} of ${runId}'s ${records.length} records put both [[A]] and [[B]] inside an <answer> tag — the pattern RM-R1's own reward function scores as a failure.` +
        (loose > strict
          ? ` A looser scan finds ${loose} with both tokens somewhere in the trace, which is a different thing: there the judge is quoting the instruction it was given ("output either [[A]] or [[B]]") while it spirals.`
          : ' Scanning the whole trace rather than the tag finds the same count.'),
      `${runId} 的 ${records.length} 条记录里，有 ${strict} 条把 [[A]] 和 [[B]] 同时写进了一个 <answer> 标签——RM-R1 自己的奖励函数把这种情况算作失败。` +
        (loose > strict
          ? ` 放宽到整段推理里去找，能找到 ${loose} 条两个标记都出现过，那是另一回事：那里是评审模型一边打转，一边把给它的指令（"output either [[A]] or [[B]]"）又抄了一遍。`
          : ' 不看标签、直接扫整段推理，数出来还是这个数。'),
    ),
    bi(
      `${noVerdict} of ${runId}'s ${records.length} records emit no <answer> tag at all, so a Chain-of-Rubrics parse of them has no verdict to report and must fall back to the raw text.`,
      `${runId} 的 ${records.length} 条记录里，有 ${noVerdict} 条根本没有写出 <answer> 标签，所以对它们做 Chain-of-Rubrics 解析时没有判定可报，只能回退到原始文本。`,
    ),
    bi(
      `${wrong} of ${runId}'s ${records.length} RewardBench judgements are wrong; ${sampleWrong} of the ${sample.length} sampled here are. Hard cases are deliberately over-represented, so this package's accuracy is not the benchmark's.`,
      `${runId} 的 ${records.length} 条 RewardBench 判例里判错了 ${wrong} 条；这里抽样的 ${sample.length} 条里判错了 ${sampleWrong} 条。难例是被刻意多放进来的，所以这个包的准确率不是基准上的准确率。`,
    ),
  ]
}

/**
 * Which of the demo's figures are the benchmark's and which are this sample's,
 * named one by one with the denominator each is over. This exists because the
 * package used to assert in prose that its numbers were the full benchmark's
 * while the dashboard computed them from 232 records: a claim in a README is not
 * a property of a file. Every entry here is either derivable from what the
 * package ships — `from` says from what — or explicitly marked `sample`.
 *
 * `basis` is one of BASES, and a view may show a figure under a benchmark's own
 * name only for 'full benchmark'.
 */
const BASES = {
  'full benchmark': bi('full benchmark', '完整基准'),
  'this sample': bi('this sample', '这份样本'),
  'as released': bi('as released', '按发布原样'),
}

/** The word a whole ledger turns on, so it is written once and reused by name. */
const basis = (name) => BASES[name] ?? fail(`coverage basis "${name}" is not one of ${Object.keys(BASES).join(', ')}`)

function coverageOf(entries) {
  return entries.map((entry) => ({ basis: BASES['full benchmark'], ...entry }))
}

/**
 * How the four section scores are formed, said once and measured every time.
 *
 * The sentence this replaced was written from memory and was false in the way
 * that matters most: it told the reader that plain accuracy over a section's
 * records and the EXAMPLE_COUNTS weighting "give the same four numbers" and that
 * the build checks both. They do not agree on Reasoning — 0.81 of a point apart
 * on this run — and the build only ever checks the recipe and the weighting,
 * because checking the plain reading would fail. Every number below is taken
 * from the table that was just packed, so the note cannot drift from the file
 * again.
 */
function sectionRecipeNote(reproduction) {
  const rows = reproduction.sectionRows.Reasoning
  const weight = reproduction.sectionWeight.Reasoning
  const plain = pct4(reproduction.sectionsPlain.Reasoning)
  const released = pct4(reproduction.sections.Reasoning)
  return bi(
    'Three of the four sections are plain accuracy over every record in the section. Reasoning is not, and that is the one thing to know here. ' +
      'The build checks the packed table against main_score.json twice: once the way the released files were made — those three plain, and Reasoning as the mean of ' +
      "math-prm's accuracy and the mean of the six hep-* accuracies — and once as the benchmark's own EXAMPLE_COUNTS weighting of the 23 per-subset accuracies. " +
      `Those two agree on all four because the weights are the log's row counts for every subset but math-prm, which has ${reproduction.mathPrmRows} rows and weighs ${reproduction.mathPrmWeight}; ` +
      `on Reasoning they agree by construction, since ${reproduction.mathPrmWeight} of ${weight} is exactly half. ` +
      `Plain accuracy over Reasoning's ${rows} rows is ${plain} — not the ${released} the released file states and this package shows — so that third formulation is neither checked nor the section score. On a sample none of the three is.`,
    '四个大项里有三个是该大项全部记录上的普通准确率。Reasoning 不是，而这正是这里唯一要记住的事。' +
      '构建会拿打包好的表去对 main_score.json 两遍：一遍照当初做出这些发布文件的算法——那三个用普通准确率，Reasoning 取 math-prm 的准确率与六个 hep-* 准确率均值这两者的平均；' +
      '另一遍按基准自己的 EXAMPLE_COUNTS，对 23 个分子集准确率加权。' +
      `这两遍在四个大项上都一致，是因为除 math-prm 外，各子集的权重就是日志里的行数，而 math-prm 有 ${reproduction.mathPrmRows} 行、权重却是 ${reproduction.mathPrmWeight}；` +
      `在 Reasoning 上这两遍更是必然一致，因为 ${weight} 里的 ${reproduction.mathPrmWeight} 正好是一半。` +
      `按普通准确率算 Reasoning 的 ${rows} 行，得到的是 ${plain}——而不是发布文件写着、这个包也在显示的 ${released}——所以第三种算法既不在被检查之列，也不是大项分数。在样本上，三种算法哪一种都不是。`,
  )
}

const pct4 = (n) => `${(n * 100).toFixed(4)}%`

/**
 * The coverage block is a claim like any other, so it is checked like one. A
 * 'full benchmark' denominator has to be the row count of a complete outcome
 * table actually in this package, and a 'this sample' denominator has to be a
 * packed log's own `sampled` count — otherwise the block would be a second place
 * for a number to be wrong rather than the place that says which numbers are
 * safe.
 */
function assertCoverage(bundle) {
  const fullSizes = new Set()
  const sampleSizes = new Set()
  // A count the browser shows is a count of JUDGEMENTS, and one RM-Bench record
  // becomes three of them — one per response style. (The three style files are
  // already three separate logs, so the factor here is 3 and not 9.) The
  // browser's own denominator is therefore not any single log's `sampled`, and
  // an entry describing the browser may use the expanded total — still derived
  // from the package, with the same multiplier the adapter applies.
  let browserTotal = 0
  for (const run of bundle.runs) {
    for (const table of run.outcome_tables) if (table.complete) fullSizes.add(table.rows.length)
    for (const log of run.logs) {
      sampleSizes.add(log.sampled)
      browserTotal += log.sampled * (log.benchmark === 'rm-bench' ? 3 : 1)
    }
  }
  sampleSizes.add(browserTotal)
  // The compare package's browser holds the same indices from both runs.
  sampleSizes.add(0)
  // `.en` is the enumerated vocabulary — the side BASES is keyed by, and the
  // side a view branches on. The reader sees whichever side they read.
  for (const entry of bundle.coverage) {
    const name = entry.basis?.en
    if (BASES[name] === undefined) fail(`coverage "${entry.figure.en}" has an unknown basis ${name}`)
    if (name === 'full benchmark' && !fullSizes.has(entry.denominator)) {
      fail(
        `coverage "${entry.figure.en}" claims the full benchmark over ${entry.denominator} items, but no complete ` +
          `outcome table in ${bundle.bundle.id} has that many rows (${[...fullSizes].join(', ')})`,
      )
    }
    if (name === 'this sample' && !sampleSizes.has(entry.denominator)) {
      fail(
        `coverage "${entry.figure.en}" claims ${entry.denominator} sampled records, but no packed log in ` +
          `${bundle.bundle.id} has that many (${[...sampleSizes].join(', ')})`,
      )
    }
  }
}

/**
 * Every sentence this package puts on screen, checked for having both sides.
 *
 * The adapter accepts a bare string and shows it to both readerships, which is
 * the right behaviour for a package somebody else wrote — their words,
 * untranslated, beat a guess at what they meant. It is the wrong behaviour for
 * ours: `notes`, `sampling` and `coverage` are the honesty disclosure, and the
 * half of it that carries the denominators and the sampling contract is exactly
 * the half a misreading turns on. So the lenient reader stays lenient and the
 * writer is strict — every path below is a place a monolingual sentence used to
 * be able to hide, which is how 25 English lines shipped inside a bilingual
 * About block for four rounds.
 *
 * A pair whose sides are identical fails too, because that is what a placeholder
 * looks like. Where the same characters really are right on both sides — a run
 * id, a file name — they belong inside a sentence, not as the whole of one.
 */
function assertBilingual(bundle) {
  const seen = []
  const check = (value, where) => {
    if (value === undefined || value === null) return
    const ok =
      typeof value === 'object' &&
      typeof value.en === 'string' &&
      value.en.trim() !== '' &&
      typeof value.zh === 'string' &&
      value.zh.trim() !== ''
    if (!ok) {
      fail(
        `${bundle.bundle.id}: ${where} is not an { en, zh } pair with both sides written ` +
          `(${JSON.stringify(value).slice(0, 80)}). The disclosure has to reach a Chinese reader ` +
          'too — nothing was written.',
      )
    }
    if (value.en === value.zh) {
      fail(
        `${bundle.bundle.id}: ${where} has the same text on both sides, so one language is a ` +
          'placeholder. Write it, or say why it is data and belongs in a record rather than in a sentence.',
      )
    }
    seen.push(where)
  }

  check(bundle.bundle.credit, 'bundle.credit')
  bundle.notes.forEach((note, i) => check(note, `notes[${i}]`))

  const sampling = bundle.sampling
  check(sampling.method, 'sampling.method')
  sampling.rules.forEach((rule, i) => check(rule, `sampling.rules[${i}]`))
  sampling.hand_picked.forEach((one, i) => check(one.why, `sampling.hand_picked[${i}].why`))
  sampling.withheld.forEach((one, i) => check(one.reason, `sampling.withheld[${i}].reason`))
  sampling.excluded.forEach((one, i) => check(one.reason, `sampling.excluded[${i}].reason`))

  bundle.coverage.forEach((entry, i) => {
    check(entry.figure, `coverage[${i}].figure`)
    check(entry.basis, `coverage[${i}].basis`)
    check(entry.from, `coverage[${i}].from`)
    check(entry.note, `coverage[${i}].note`)
  })

  if (bundle.featured_record) {
    check(bundle.featured_record.why, 'featured_record.why')
    check(bundle.featured_record.selected_by, 'featured_record.selected_by')
  }
  return seen.length
}

const SAMPLE_ONLY_FIGURES = (rbSampled, rbTotal, rmSampledIds, rmTotalIds, rmbRecords = 0) => [
  {
    figure: bi(
      'The judgement browser: which records can be opened and read, and every count and filter inside it',
      '判例浏览器：哪些记录能打开来读，以及它里面的每一个计数和筛选',
    ),
    basis: basis('this sample'),
    // The browser lists JUDGEMENTS, and one RM-Bench id is nine of them — three
    // style files, three comparisons each. Quoting the RewardBench sample size
    // alone sends a reader looking for the denominator of "270 of 508" and hands
    // them 232, which is the one thing this ledger exists to prevent.
    denominator: rbSampled + rmSampledIds * 9 + rmbRecords,
    from: bi(
      'runs[].logs[].records — the only records whose text travels',
      'runs[].logs[].records —— 只有这些记录的文本随包带出来',
    ),
    note: bi(
      `${rbSampled} of ${rbTotal} RewardBench records, and ${rmSampledIds} of ` +
        `${rmTotalIds} RM-Bench ids which the browser lists as ${rmSampledIds * 9} ` +
        `judgements — three style files, three comparisons each` +
        (rmbRecords > 0 ? `, plus ${rmbRecords} RMB records in full` : '') +
        `. So a RewardBench count is out of ${rbSampled}, an RM-Bench count out of ` +
        `${rmSampledIds * 9}, and an unfiltered count out of ` +
        `${rbSampled + rmSampledIds * 9 + rmbRecords}. Filtering, searching and ` +
        'counting inside the browser are over these, never over the benchmark.',
      `RewardBench 的 ${rbTotal} 条里取了 ${rbSampled} 条；RM-Bench 的 ${rmTotalIds} 个 id 里取了 ` +
        `${rmSampledIds} 个，而浏览器把它们列为 ${rmSampledIds * 9} 条判例——三个风格文件，每个三次比较` +
        (rmbRecords > 0 ? `；另有 ${rmbRecords} 条 RMB 记录整条收录` : '') +
        `。所以：RewardBench 的计数以 ${rbSampled} 为分母，RM-Bench 的以 ${rmSampledIds * 9} 为分母，` +
        `不加筛选时以 ${rbSampled + rmSampledIds * 9 + rmbRecords} 为分母。浏览器里的筛选、搜索和计数` +
        '都是在这些记录上做的，从来不是在整个基准上。',
    ),
  },
  {
    figure: bi("This sample's own accuracy", '这份样本自己的准确率'),
    basis: basis('this sample'),
    denominator: rbSampled,
    from: bi(
      'runs[].logs[].accuracy.sample, beside accuracy.full_set',
      'runs[].logs[].accuracy.sample，紧挨着的就是 accuracy.full_set',
    ),
    note: bi(
      'The sample over-represents the model\'s mistakes on purpose, so this number is far below the benchmark\'s and is not an estimate of it. It may not be shown without accuracy.full_set beside it, and it may not be given a section\'s or a benchmark\'s name.',
      '样本是刻意多放模型错例的，所以这个数远低于基准上的数，也不是对它的估计。显示它时必须把 accuracy.full_set 放在旁边，也不许给它安上某个大项或某个基准的名字。',
    ),
  },
  {
    figure: bi(
      'Anything read out of a Chain-of-Rubrics trace: rubric route, criteria, evidence spans, whether an <answer> tag is present',
      '任何从 Chain-of-Rubrics 推理里读出来的东西：评分路线、评分标准、证据片段、有没有 <answer> 标签',
    ),
    basis: basis('this sample'),
    denominator: rbSampled,
    from: bi(
      'the sampled records only — the outcome tables carry no text',
      '只有抽样到的那些记录 —— 结果表里不带文本',
    ),
    note: bi(
      'A distribution over these is the sample\'s distribution. The full run\'s counts for the two that matter are in "notes", measured at build time.',
      '在这些记录上做出来的分布，是这份样本的分布。整个运行里真正要紧的那两个计数写在 "notes" 里，是构建时数出来的。',
    ),
  },
]

function bundleHeader(id, title, credit) {
  return {
    agentlens_format: FORMAT,
    built_by: 'scripts/build-demo-data/rm-r1.mjs',
    bundle: {
      id,
      title,
      credit,
      source_repo: SOURCE_REPO,
      source_license: SOURCE_LICENSE,
      source_root: SOURCE_ROOT,
    },
  }
}

/* ------------------------------------------------------------------- main */

function main() {
  const dir = resolveSourceDir()
  process.stdout.write(`source: ${dir}\n`)

  /* ---- main package: one run, all four log families ---- */

  const rbRecords = readJson(dir, join(MAIN_RUN, REWARD_BENCH_LOG))
  const rbSample = rewardBenchSample(rbRecords)
  const rbPath = `${MAIN_RUN}/${REWARD_BENCH_LOG}`

  const rmParts = [1, 2, 3].map((part) => readJson(dir, join(MAIN_RUN, RM_BENCH_LOG(MAIN_RUN, part))))
  const rmPaths = [1, 2, 3].map((part) => `${MAIN_RUN}/${RM_BENCH_LOG(MAIN_RUN, part)}`)
  const rmIds = rmBenchSample(rmParts)

  const withheldPaths = new Set(WITHHELD.map((w) => `${MAIN_RUN}/${w.source_suffix}`))
  const rmbEntries = RMB_LOGS.map((spec) => ({ spec, path: `${MAIN_RUN}/${spec.path}` }))
    .filter(({ path }) => !withheldPaths.has(path))
    .map(({ spec, path }) => {
      const records = readJson(dir, join(MAIN_RUN, spec.path))
      return logEntry({
        runId: MAIN_RUN,
        sourcePath: path,
        benchmark: spec.benchmark,
        items: records.map((value, source_index) => ({ value, source_index })),
        sourceTotal: records.length,
      })
    })

  const scores = SCORE_FILES.map((spec) => scoreEntry(dir, MAIN_RUN, spec))
  assertScoresAreNumbers(scores)

  const rbFullAccuracy = accuracyOf(rbRecords.map((r) => r.results))
  const rbSampleAccuracy = accuracyOf(rbSample.map((item) => item.value.results))

  const mainRun = {
    run_id: MAIN_RUN,
    logs: [
      logEntry({
        runId: MAIN_RUN,
        sourcePath: rbPath,
        benchmark: 'rewardbench',
        items: rbSample,
        sourceTotal: rbRecords.length,
        extra: {
          accuracy: { sample: rbSampleAccuracy, full_set: rbFullAccuracy },
        },
      }),
      ...rmParts.map((part, i) =>
        logEntry({
          runId: MAIN_RUN,
          sourcePath: rmPaths[i],
          benchmark: 'rm-bench',
          items: rmIds.map((source_index) => ({ value: part[source_index], source_index })),
          sourceTotal: part.length,
          extra: { style_pairing: i + 1 },
        }),
      ),
      ...rmbEntries,
    ],
    outcome_tables: [
      rewardBenchOutcomes(rbRecords, rbPath, MAIN_RUN),
      rmBenchOutcomes(rmParts, rmPaths, MAIN_RUN),
    ],
    scores,
  }
  const mainReproduction = assertOutcomeTablesReproduceScores(mainRun)

  // Everything cut so far belongs to the package below; the compare package's
  // own cuts are whatever `truncateField` appends after this line.
  const mainTruncations = truncations.slice()

  const featured = HAND_PICKED_REWARDBENCH.map(({ source_index, why }) => ({
    run_id: MAIN_RUN,
    source_path: rbPath,
    source_index,
    source_id: rbRecords[source_index].id,
    subset: rbRecords[source_index].subset,
    // The id the shell's `?record=` deep link uses, so a view can render this
    // list as working links instead of asking the reader to construct one.
    record_id: `${rbPath.slice(rbPath.lastIndexOf('/') + 1)}:${source_index}`,
    why,
  }))

  // Counted, not remembered: THIRD_PARTY_NOTICES.md says "two records withheld".
  const withheld = WITHHELD.map((w) => {
    const source_path = `${MAIN_RUN}/${w.source_suffix}`
    return { source_path, records: readJson(dir, join(MAIN_RUN, w.source_suffix)).length, reason: w.reason }
  })

  const accounting = fileAccounting(dir, MAIN_RUN, [
    ...mainRun.logs.map((log) => log.source_path.slice(MAIN_RUN.length + 1)),
    ...SCORE_FILES.map((spec) => spec.path),
  ])

  const rmbSourceTotal = rmbEntries.reduce((sum, entry) => sum + entry.source_total, 0)
  const mainCoverage = [
    ...coverageOf([
      {
        figure: bi(
          'RewardBench accuracy by subset (all 23)',
          'RewardBench 各分子集的准确率（全部 23 个）',
        ),
        denominator: rbRecords.length,
        from: bi(
          'runs[].outcome_tables[benchmark="rewardbench"] — source_index, id, subset and outcome for every record',
          'runs[].outcome_tables[benchmark="rewardbench"] —— 每一条记录的 source_index、id、subset 和结果',
        ),
        note: bi(
          `Reproduces the run's own each_small_section_score.json exactly; the build fails if it stops doing so (worst difference across all ${mainReproduction.checked} checked values this build: ${mainReproduction.worst}).`,
          `与该运行自己的 each_small_section_score.json 完全一致；一旦不再一致，构建就失败（这次构建在全部 ${mainReproduction.checked} 个被检查的数值上，最大差异是 ${mainReproduction.worst}）。`,
        ),
      },
      {
        figure: bi(
          'The four RewardBench sections (Chat, Chat Hard, Safety, Reasoning), avg_Result_each_section and absoluate_Result',
          'RewardBench 的四个大项（Chat、Chat Hard、Safety、Reasoning），以及 avg_Result_each_section 和 absoluate_Result',
        ),
        denominator: rbRecords.length,
        from: bi(
          'the same table, grouped the way RewardBench groups its subsets',
          '同一张表，按 RewardBench 自己对分子集的分组来分组',
        ),
        // Every figure in this sentence is measured from the table three lines
        // above, because the sentence it replaced was a remembered one and was
        // false: it told the reader plain accuracy and the EXAMPLE_COUNTS
        // weighting give the same four numbers, when on Reasoning they differ by
        // 0.81 of a point and only the weighting is ever checked.
        note: sectionRecipeNote(mainReproduction),
      },
      {
        figure: bi(
          'The RM-Bench 3x3 style matrix, per domain and overall, and hard_acc / normal_acc / easy_acc / total_avg_acc',
          'RM-Bench 的 3x3 风格矩阵（每个 domain 与总体），以及 hard_acc / normal_acc / easy_acc / total_avg_acc',
        ),
        denominator: rmParts[0].length,
        from: bi(
          'runs[].outcome_tables[benchmark="rm-bench"] — every id\'s three result triples across all three style files',
          'runs[].outcome_tables[benchmark="rm-bench"] —— 每个 id 在三个风格文件里的三组 result 三元组',
        ),
        note: bi(
          'Both assemblies are derivable from this table: the one the shipped process_final_result.py performs, which the build checks against the released final_result.json, and the one that reads total_dataset_2 into data2.',
          '两种拼法都能从这张表推出来：随包发布的 process_final_result.py 实际执行的那一种（构建会拿它去对发布的 final_result.json），以及把 total_dataset_2 读进 data2 的那一种。',
        ),
      },
    ]),
    {
      figure: bi(
        'RMB: judgements only. No RMB accuracy is computed or shown anywhere.',
        'RMB：只有判例。任何地方都不计算、也不显示 RMB 的准确率。',
      ),
      basis: basis('as released'),
      denominator: rmbSourceTotal,
      from: bi(
        `runs[].logs[] — ${rmbEntries.length} of the ${RMB_LOGS.length} released RMB logs, whole`,
        `runs[].logs[] —— 公开的 ${RMB_LOGS.length} 份 RMB 日志里的 ${rmbEntries.length} 份，整份收录`,
      ),
      note: bi(
        'These log files hold 2 records each in the release, so they are a handful of examples and not the RMB benchmark. They travel unsampled, but no denominator here is RMB\'s: the run\'s actual RMB scores live in the score files, which this package carries unmodified and the viewer does not read. The BoN Harmlessness pair is withheld for content reasons and is listed under sampling.withheld.',
        '这些日志文件在公开发布里每份只有 2 条记录，所以它们是几个例子，不是 RMB 基准。它们没有被抽样，但这里没有哪个分母是 RMB 的：该运行真正的 RMB 分数在分数文件里，这个包原样带着它们，而查看器并不读。BoN Harmlessness 那一对出于内容原因被保留不发，列在 sampling.withheld 里。',
      ),
    },
    ...SAMPLE_ONLY_FIGURES(rbSample.length, rbRecords.length, rmIds.length, rmParts[0].length, rmbSourceTotal),
  ]

  const mainBundle = {
    ...bundleHeader(
      'rm-r1',
      `RM-R1 judgement logs — ${MAIN_RUN}`,
      bi(
        `Official ${MAIN_RUN} evaluation logs from RM-R1-UIUC/RM-R1, Apache-2.0 — a declared sample, ${verbatimPhrase(mainTruncations).en}`,
        `RM-R1-UIUC/RM-R1 公开发布的 ${MAIN_RUN} 评测日志，Apache-2.0 —— 一份已声明的样本，${verbatimPhrase(mainTruncations).zh}`,
      ),
    ),
    sampling: {
      deterministic: true,
      method: bi(
        'stratified systematic sampling over source file order; no RNG, no seed',
        '按源文件顺序做的分层系统抽样；不用随机数发生器，也没有种子',
      ),
      rules: SAMPLING_RULES,
      hand_picked: featured,
      withheld,
      excluded: accounting.excluded,
      truncated: mainTruncations,
    },
    coverage: mainCoverage,
    notes: [...NOTES, ...measuredNotes(MAIN_RUN, rbRecords, rbSample.map((item) => item.value)), ...RMB_NOTES],
    featured_record: {
      ...featured[0],
      selected_by: bi(
        'hand-picked by the AgentLens author as a legible example — a curator\'s choice, not a measurement',
        '由 AgentLens 作者手挑的一个易读例子——这是策展人的选择，不是一次测量',
      ),
    },
    runs: [mainRun],
  }

  /* ---- compare package: the same RewardBench items, two released runs ---- */

  const otherRecords = readJson(dir, join(OTHER_RUN, REWARD_BENCH_LOG))
  const otherPath = `${OTHER_RUN}/${REWARD_BENCH_LOG}`
  if (otherRecords.length !== rbRecords.length) {
    fail(`RewardBench runs have different lengths (${rbRecords.length} vs ${otherRecords.length})`)
  }
  let sameShuffle = 0
  for (let i = 0; i < rbRecords.length; i++) {
    if (rbRecords[i].id !== otherRecords[i].id || rbRecords[i].subset !== otherRecords[i].subset) {
      fail(`RewardBench runs are not index-aligned at ${i}`)
    }
    if (
      rbRecords[i].Is_Chosen_Answer_Shuffled_toPositionB ===
      otherRecords[i].Is_Chosen_Answer_Shuffled_toPositionB
    ) {
      sameShuffle += 1
    }
  }

  const indices = rbRecords.map((_, i) => i)
  const smallPair = (i) =>
    bytes(rbRecords[i]) <= MAX_RECORD_BYTES && bytes(otherRecords[i]) <= MAX_RECORD_BYTES
  const cmpIds = [
    ...stride(indices.filter((i) => rbRecords[i].results === 1 && otherRecords[i].results === 0), CMP_A_RIGHT_B_WRONG, smallPair),
    ...stride(indices.filter((i) => rbRecords[i].results === 0 && otherRecords[i].results === 1), CMP_A_WRONG_B_RIGHT, smallPair),
    ...stride(indices.filter((i) => rbRecords[i].results === 0 && otherRecords[i].results === 0), CMP_BOTH_WRONG, smallPair),
  ].sort((a, b) => a - b)

  const compareRun = (runId, records, sourcePath, spec) => ({
    run_id: runId,
    logs: [
      logEntry({
        runId,
        sourcePath,
        benchmark: 'rewardbench',
        items: cmpIds.map((source_index) => ({ value: records[source_index], source_index })),
        sourceTotal: records.length,
        extra: {
          accuracy: {
            sample: accuracyOf(cmpIds.map((i) => records[i].results)),
            full_set: accuracyOf(records.map((r) => r.results)),
          },
        },
      }),
    ],
    outcome_tables: [rewardBenchOutcomes(records, sourcePath, runId)],
    scores: spec.map((one) => scoreEntry(dir, runId, one)),
  })

  const compareScores = SCORE_FILES.filter((s) => s.path.startsWith('reward_bench/'))
  const compareRuns = [
    compareRun(MAIN_RUN, rbRecords, rbPath, compareScores),
    compareRun(OTHER_RUN, otherRecords, otherPath, compareScores),
  ]
  for (const run of compareRuns) assertScoresAreNumbers(run.scores)
  const compareReproduction = compareRuns.map((run) => assertOutcomeTablesReproduceScores(run))

  // Computed here only to prove the package can produce it: the tables ship, the
  // view derives it. If this stopped being derivable the rule below would be a
  // sentence about a number nothing on screen could reach.
  const fullAgreement = agreementFromTables(
    compareRuns[0].outcome_tables[0],
    compareRuns[1].outcome_tables[0],
  )
  if (fullAgreement.aligned !== rbRecords.length) {
    fail(`only ${fullAgreement.aligned} of ${rbRecords.length} items align across the two outcome tables`)
  }

  const compareBundle = {
    ...bundleHeader(
      'rm-r1-compare',
      'RM-R1 run compare — two released 32B checkpoints on RewardBench',
      bi(
        `Official ${MAIN_RUN} and ${OTHER_RUN} evaluation logs from RM-R1-UIUC/RM-R1, Apache-2.0 — a declared sample of the items the two runs answer differently, ${verbatimPhrase(truncations.slice(mainTruncations.length)).en}`,
        `RM-R1-UIUC/RM-R1 公开发布的 ${MAIN_RUN} 与 ${OTHER_RUN} 评测日志，Apache-2.0 —— 一份已声明的样本，取的是两个运行答得不一样的题目，${verbatimPhrase(truncations.slice(mainTruncations.length)).zh}`,
      ),
    ),
    sampling: {
      deterministic: true,
      method: bi(
        'stratified systematic sampling over source file order; no RNG, no seed',
        '按源文件顺序做的分层系统抽样；不用随机数发生器，也没有种子',
      ),
      rules: [
        SAMPLING_RULES[0],
        bi(
          `Scope: RewardBench only. Each run contributes its reward_bench log and the two reward_bench score files the release ships with it, and nothing else — the RM-Bench and RMB families are not in this package at all (the single-run package carries the ${MAIN_RUN} run's).`,
          `范围：只有 RewardBench。每个运行只贡献自己的 reward_bench 日志，以及随它发布的那两个 reward_bench 分数文件，别的都不带——RM-Bench 和 RMB 这两族根本不在这个包里（单运行的那个包带的是 ${MAIN_RUN} 的）。`,
        ),
        bi(
          `Both runs answer the same ${rbRecords.length} RewardBench items in the same order, so the sample is a set of source indices taken from both runs. It is drawn only from items the two runs answer differently (${CMP_A_RIGHT_B_WRONG} each way) plus items both get wrong (${CMP_BOTH_WRONG}) — the cases a compare view exists for, and the hardest ones in the file.`,
          `两个运行按同样的顺序回答同样的 ${rbRecords.length} 条 RewardBench 题目，所以这份样本就是一组源位置，两个运行都按这组位置取。它只从两个运行答得不一样的题目里抽（两个方向各 ${CMP_A_RIGHT_B_WRONG} 条），再加上两个都答错的（${CMP_BOTH_WRONG} 条）——对照视图存在的意义就在这些题目上，它们也是整份文件里最难的。`,
        ),
        bi(
          `Neither run's accuracy over this sample resembles its accuracy over the benchmark: over these ${cmpIds.length} items each run is right ${CMP_A_RIGHT_B_WRONG} times by construction, and over the benchmark they score ${(accuracyOf(rbRecords.map((r) => r.results)) * 100).toFixed(2)}% and ${(accuracyOf(otherRecords.map((r) => r.results)) * 100).toFixed(2)}%. The complete outcome table for both runs is included and tagged with its run, joinable on source_index, so the run-to-run agreement matrix, the per-group movement beside it and every per-subset and section number are computed over all ${rbRecords.length} items rather than over these ${cmpIds.length}. The build recomputes the agreement matrix from the two packed tables and fails if they do not align at every position.`,
          `两个运行在这份样本上的准确率，都不像它们在基准上的准确率：在这 ${cmpIds.length} 条上，按构造每个运行各答对 ${CMP_A_RIGHT_B_WRONG} 条，而在整个基准上它们分别是 ${(accuracyOf(rbRecords.map((r) => r.results)) * 100).toFixed(2)}% 和 ${(accuracyOf(otherRecords.map((r) => r.results)) * 100).toFixed(2)}%。两个运行的完整结果表都在包里，各自标明属于哪个运行，可以按 source_index 连接，所以运行之间的一致性矩阵、旁边的分组变化，以及每一个分子集和大项数字，都是在全部 ${rbRecords.length} 条上算的，而不是在这 ${cmpIds.length} 条上。构建会用打包好的两张表重算一致性矩阵，只要有一处对不齐就失败。`,
        ),
        bi(
          `The shuffle flag travels in the same table, and how often the two runs shuffled alike is stated over all ${rbRecords.length} items in "notes". The panel that reads the judges' own [[A]]/[[B]] letters cannot be widened that way — a letter only means something beside the text it was written about — so it counts only the ${cmpIds.length} records whose text travels and says so on its face, like the judgement list beside it.`,
          `位置打乱标记也在同一张表里，两个运行打乱得一样的次数，是在全部 ${rbRecords.length} 条上统计的，写在 "notes" 里。读评审自己写下的 [[A]]/[[B]] 字母的那个面板没法这样放大——一个字母只有贴着它所评的文本才有意义——所以它只统计文本随包带出来的那 ${cmpIds.length} 条，并且像旁边的判例列表一样，把这件事写在明面上。`,
        ),
        bi(
          `The two tables are aligned on source_index, not on id: RewardBench's id is not unique in these logs (3692 appears under both donotanswer and hep-python). The build checks that both runs agree on id and subset at all ${rbRecords.length} positions before packing them.`,
          `两张表按 source_index 对齐，而不是按 id：在这些日志里 RewardBench 的 id 并不唯一（3692 在 donotanswer 和 hep-python 下各出现一次）。构建会先检查两个运行在全部 ${rbRecords.length} 个位置上的 id 和 subset 都一致，然后才打包。`,
        ),
        bi(
          'What the sample decides is which judgements can be opened and read side by side, and the A/B position note that can only be read against their text. Nothing else: every figure that carries a benchmark\'s name is computed from the outcome tables, and `coverage` in this package names which is which, figure by figure. Two runs are loaded here, so no figure belongs to "the model": each belongs to one named run, the two runs\' score files are never merged, and a number that cannot name its run is not shown at all.',
          '这份样本决定的只有：哪些判例可以打开并排读，以及只能贴着它们的文本才读得出的 A/B 位置注记。此外再无别的：每一个挂着基准名字的数字都是从结果表算出来的，这个包里的 `coverage` 逐条写明哪个是哪个。这里载入了两个运行，所以没有哪个数字属于「这个模型」：每个数字都属于某一个具名的运行，两个运行的分数文件从不合并，说不清属于哪个运行的数字一概不显示。',
        ),
      ],
      hand_picked: [],
      withheld: [],
      excluded: [],
      truncated: truncations.slice(mainTruncations.length),
    },
    coverage: [
      ...coverageOf(
        compareRuns.flatMap((run, i) => [
          {
            figure: bi(
              `RewardBench accuracy by subset, and the four sections — ${run.run_id}`,
              `RewardBench 各分子集的准确率，以及四个大项 —— ${run.run_id}`,
            ),
            denominator: rbRecords.length,
            from: bi(
              `runs[${i}].outcome_tables[0], tagged run_id "${run.run_id}"`,
              `runs[${i}].outcome_tables[0]，标着 run_id "${run.run_id}"`,
            ),
            note: bi(
              `Reproduces this run's own released score files exactly — all ${compareReproduction[i].checked} checked values, worst difference this build ${compareReproduction[i].worst}. Two runs are loaded, so no figure here may be shown without naming the run it belongs to, and the two score files may not be merged: over the whole benchmark this run scores ${(compareReproduction[i].absoluate_Result * 100).toFixed(2)}%.`,
              `与这个运行自己发布的分数文件完全一致——全部 ${compareReproduction[i].checked} 个被检查的数值，这次构建最大差异 ${compareReproduction[i].worst}。这里载入了两个运行，所以任何数字都必须写明属于哪个运行才能显示，两个分数文件也不许合并：在整个基准上，这个运行的成绩是 ${(compareReproduction[i].absoluate_Result * 100).toFixed(2)}%。`,
            ),
          },
        ]),
      ),
      ...coverageOf([
        {
          figure: bi(
            'The run-to-run agreement matrix (both right / one only / both wrong) and the per-group movement beside it',
            '运行之间的一致性矩阵（都对／只有一个对／都错），以及旁边的分组变化',
          ),
          denominator: rbRecords.length,
          from: bi(
            'the two outcome tables, joined on source_index',
            '两张结果表，按 source_index 连接',
          ),
          note: bi(
            `${fullAgreement.both_right} both right, ${fullAgreement.a_only} only ${MAIN_RUN}, ${fullAgreement.b_only} only ${OTHER_RUN}, ${fullAgreement.both_wrong} both wrong, over all ${fullAgreement.aligned} items. The build recomputes this from the packed tables and fails if they do not align. Both tables name their run, which is what allows the matrix to be shown at all: with no complete table for both sides the view states the caveat instead of the number.`,
            `都对 ${fullAgreement.both_right} 条，只有 ${MAIN_RUN} 对 ${fullAgreement.a_only} 条，只有 ${OTHER_RUN} 对 ${fullAgreement.b_only} 条，都错 ${fullAgreement.both_wrong} 条，覆盖全部 ${fullAgreement.aligned} 条。构建会用打包好的两张表重算这个矩阵，对不齐就失败。两张表都写明自己属于哪个运行，正是这一点才让这个矩阵可以显示：如果两边没有各自完整的结果表，视图就只说明这个限制，而不给数字。`,
          ),
        },
      ]),
      {
        figure: bi(
          'The A/B position note: how often the two runs shuffled the slots differently, and how often the raw [[A]]/[[B]] letters would disagree with the normalised verdict',
          'A/B 位置注记：两个运行把槽位打乱得不一样的次数，以及原始的 [[A]]/[[B]] 字母与归一化后的判定不一致的次数',
        ),
        basis: basis('this sample'),
        denominator: cmpIds.length,
        from: bi(
          'runs[].logs[0].records — the shuffle flag is in the table, but the letters it has to be read against are only in the text',
          'runs[].logs[0].records —— 打乱标记在结果表里，但要跟它对着读的那些字母只在文本里',
        ),
        note: bi(
          `Over the ${cmpIds.length} records whose text travels, not over the ${rbRecords.length}. How often the two runs shuffled alike across the whole benchmark is a measured count in "notes" instead, because that one needs no text.`,
          `是在文本随包带出来的这 ${cmpIds.length} 条上算的，不是在 ${rbRecords.length} 条上。两个运行在整个基准上打乱得一样的次数，改成写在 "notes" 里的一个实测计数，因为那一个不需要文本。`,
        ),
      },
      {
        figure: bi(
          'The judgement browser and the side-by-side reading of a disagreement',
          '判例浏览器，以及把一处分歧并排读',
        ),
        basis: basis('this sample'),
        denominator: cmpIds.length,
        from: bi(
          'runs[].logs[0].records — the same source indices from both runs',
          'runs[].logs[0].records —— 两个运行取的是同样的一组源位置',
        ),
        note: bi(
          `${cmpIds.length} of ${rbRecords.length} items: ${CMP_A_RIGHT_B_WRONG} that only the first run answers, ${CMP_A_RIGHT_B_WRONG} that only the second does, and ${cmpIds.length - 2 * CMP_A_RIGHT_B_WRONG} that neither does. None that both answer, which is why counting anything over this list gives ${CMP_A_RIGHT_B_WRONG}/${cmpIds.length} for either run by construction; that is a property of the sample, not of either checkpoint.`,
          `${rbRecords.length} 条里的 ${cmpIds.length} 条：${CMP_A_RIGHT_B_WRONG} 条只有第一个运行答对，${CMP_A_RIGHT_B_WRONG} 条只有第二个答对，还有 ${cmpIds.length - 2 * CMP_A_RIGHT_B_WRONG} 条两个都没答对。两个都答对的一条没有——所以在这个列表上不管数什么，按构造两个运行都会得到 ${CMP_A_RIGHT_B_WRONG}/${cmpIds.length}；那是这份样本的性质，不是任何一个检查点的性质。`,
        ),
      },
    ],
    notes: [
      ...NOTES,
      ...measuredNotes(MAIN_RUN, rbRecords, cmpIds.map((i) => rbRecords[i])),
      ...measuredNotes(OTHER_RUN, otherRecords, cmpIds.map((i) => otherRecords[i])),
      bi(
        `Is_Chosen_Answer_Shuffled_toPositionB agrees on ${sameShuffle} of the ${rbRecords.length} items across these two runs, so aligning them needs no normalisation. That is a measured property of these two released files, not a guarantee about any pair of runs — the harness shuffles without a seed.`,
        `在这两个运行之间，Is_Chosen_Answer_Shuffled_toPositionB 在 ${rbRecords.length} 条里有 ${sameShuffle} 条是一致的，所以把它们对齐不需要再做归一化。这是对这两个公开文件量出来的性质，不是对任意两个运行的保证——评测脚本打乱位置时没有固定随机种子。`,
      ),
    ],
    runs: compareRuns,
  }

  /* ---- check, then write, then check what was written ---- */

  // Serialise both packages and clear them before anything touches the disk: a
  // leak or an over-budget build must leave no file behind to be committed by
  // someone who did not read the error.
  for (const bundle of [mainBundle, compareBundle]) {
    assertCoverage(bundle)
    const sentences = assertBilingual(bundle)
    process.stdout.write(`${bundle.bundle.id}: ${sentences} sentences, both languages written\n`)
  }

  const pending = [
    { name: 'rm-r1-32b.json', text: JSON.stringify(mainBundle) },
    { name: 'rm-r1-compare.json', text: JSON.stringify(compareBundle) },
  ]
  for (const file of pending) assertNoLeaks(file.name, file.text)
  const total = pending.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0)
  if (total > TOTAL_BUDGET_BYTES) {
    fail(`${kb(total)} over a ${kb(TOTAL_BUDGET_BYTES)} budget — nothing was written`)
  }

  // `report` is where the RM-Bench reproduction is checked, and that check is
  // what licenses the claim the demo is built to make. It runs before the write
  // for the same reason the leak check does: a package that fails it must not
  // exist on disk for someone to commit past the error.
  report(mainBundle, mainReproduction, fullAgreement)
  for (const bundle of [mainBundle, compareBundle]) printCoverage(bundle)

  mkdirSync(OUT_DIR, { recursive: true })
  for (const file of pending) {
    const size = write(file.name, file.text)
    const hash = createHash('sha256').update(file.text).digest('hex')
    process.stdout.write(`wrote ${file.name}  ${kb(size)}  sha256:${hash.slice(0, 12)}\n`)
  }
  process.stdout.write(`total ${kb(total)} of ${kb(TOTAL_BUDGET_BYTES)} budget\n`)
}

function write(name, text) {
  const path = join(OUT_DIR, name)
  writeFileSync(path, text)

  // Read back rather than trust the object: what ships is the file. If the file
  // on disk fails the check it is deleted before the build stops — the whole
  // point of checking the bytes is that the bytes are what would be committed,
  // so leaving them there would defeat it.
  const onDisk = readFileSync(path, 'utf8')
  const leak = leakIn(onDisk)
  const wrongFormat = JSON.parse(onDisk).agentlens_format !== FORMAT
  if (leak || wrongFormat) {
    rmSync(path, { force: true })
    fail(
      (leak
        ? `${name} on disk contains ${leak} — redaction failed`
        : `${name} on disk lost its agentlens_format declaration`) +
        `; the file was deleted rather than left where it could be committed`,
    )
  }
  return Buffer.byteLength(text)
}

/**
 * The one thing that must never ship. Both markers come from the `model` field
 * of the released score files: an internal checkpoint path that names the
 * training data recipe.
 */
const LEAK_MARKERS = [/wzq016/i, /filtered_sky/i]

/** The marker that matched, or null. A fragment of the name is not the recipe. */
function leakIn(text) {
  return LEAK_MARKERS.find((marker) => marker.test(text)) ?? null
}

function assertNoLeaks(name, text) {
  const marker = leakIn(text)
  if (marker) fail(`${name} contains ${marker} — redaction failed, nothing was published`)
}

const kb = (n) => `${(n / 1024).toFixed(0)} KB`

/** Keeps the credit line honest about the one thing sampling can change. */
const verbatimPhrase = (cuts) =>
  cuts.length === 0
    ? bi('records verbatim', '记录逐字未改')
    : bi(
        `records verbatim apart from ${cuts.length} marked truncation${cuts.length === 1 ? '' : 's'}`,
        `记录逐字未改，只有 ${cuts.length} 处标注过的截断`,
      )

/* --------------------------------------------------------------- reporting */

/**
 * Printed, not stored. The RM-Bench numbers below are the reason the package
 * carries a complete outcome table: a view can derive all three columns from the
 * shipped file, and the "shipped" column matching the "as the script computes
 * it" column is what licenses the claim that the corrected column differs by one
 * line of `process_final_result.py` and nothing else.
 */
function report(bundle, reproduction, agreement) {
  const [run] = bundle.runs
  const rb = run.logs.find((log) => log.benchmark === 'rewardbench')
  const subsets = new Set(rb.records.map((r) => r.subset))
  process.stdout.write(
    `\nRewardBench sample: ${rb.sampled} of ${rb.source_total}, ${subsets.size} subsets, ` +
      `${rb.records.filter((r) => r.results === 0).length} wrong ` +
      `(sample accuracy ${rb.accuracy.sample.toFixed(4)}, full set ${rb.accuracy.full_set.toFixed(4)})\n`,
  )
  if (subsets.size !== 23) fail(`expected all 23 RewardBench subsets, sampled ${subsets.size}`)
  if (!rb.records.some((r) => r.results === 0) || !rb.records.some((r) => r.results === 1)) {
    fail('RewardBench sample must contain both correct and incorrect judgements')
  }

  const rmLogs = run.logs.filter((log) => log.benchmark === 'rm-bench')
  const ids = rmLogs.map((log) => JSON.stringify(log.source_indices))
  if (new Set(ids).size !== 1) fail('RM-Bench style files were sampled on different ids')
  process.stdout.write(
    `RM-Bench sample: ${rmLogs[0].sampled} ids x 3 style files = ${rmLogs[0].sampled * 3} records ` +
      `of ${rmLogs[0].source_total * 3}\n`,
  )
  process.stdout.write(`truncated records: ${truncations.length}\n\n`)

  const table = run.outcome_tables.find((t) => t.benchmark === 'rm-bench')
  const shipped = run.scores.find((s) => s.source_path.endsWith('RM-Bench/final_result.json')).value
  const asShipped = rmBenchMetrics(table, true)
  const corrected = rmBenchMetrics(table, false)
  process.stdout.write('RM-Bench, from the complete outcome table in the package:\n')
  process.stdout.write('  metric          shipped   script as written   with data2 read from file 2\n')
  for (const key of Object.keys(corrected)) {
    process.stdout.write(
      `  ${key.padEnd(14)} ${fmt(shipped[key])}   ${fmt(asShipped[key]).padEnd(17)}   ${fmt(corrected[key])}\n`,
    )
    if (Math.abs(shipped[key] - asShipped[key]) > 1e-9) {
      fail(`recomputation does not reproduce the shipped ${key}; the finding is not safe to state`)
    }
  }

  const main = run.scores.find((s) => s.source_path.endsWith('main_score.json')).value
  process.stdout.write('\nRewardBench, from the complete outcome table in the package:\n')
  process.stdout.write('  section                  released   from the packed table\n')
  for (const [section, value] of Object.entries(reproduction.sections)) {
    process.stdout.write(`  ${section.padEnd(22)} ${fmt(main[section])}      ${fmt(value)}\n`)
  }
  for (const key of ['avg_Result_each_section', 'absoluate_Result']) {
    process.stdout.write(`  ${key.padEnd(22)} ${fmt(main[key])}      ${fmt(reproduction[key])}\n`)
  }
  // Said the way it is computed, not the way it is remembered. The line this
  // replaced claimed the sections reproduce main_score.json "both ways — plain
  // accuracy over the section's records, and the EXAMPLE_COUNTS weighting",
  // which is false for Reasoning and was copied into the package and the README.
  process.stdout.write(
    `  ${reproduction.subsets} per-subset accuracies also reproduce each_small_section_score.json. The four\n` +
      `  sections reproduce main_score.json two ways: as the released files were made — Chat, Chat Hard and\n` +
      `  Safety plain over the section's records, Reasoning as the mean of math-prm and the mean of the six\n` +
      `  hep-* — and as the benchmark's own EXAMPLE_COUNTS weighting of the per-subset accuracies, which on\n` +
      `  Reasoning is the same thing (${reproduction.mathPrmWeight} of ${reproduction.sectionWeight.Reasoning} is exactly half). Plain accuracy over Reasoning's\n` +
      `  ${reproduction.sectionRows.Reasoning} rows is ${pct4(reproduction.sectionsPlain.Reasoning)}, not the released ${pct4(reproduction.sections.Reasoning)} — that third formulation is not\n` +
      `  checked, because it is not the section score. Worst difference across all ${reproduction.checked} checked values:\n` +
      `  ${reproduction.worst}\n`,
  )

  process.stdout.write(
    `\nCompare package, agreement over all ${agreement.aligned} items (from the two packed tables, joined on source_index):\n` +
      `  both right ${agreement.both_right} · only ${MAIN_RUN} ${agreement.a_only} · ` +
      `only ${OTHER_RUN} ${agreement.b_only} · both wrong ${agreement.both_wrong}\n`,
  )
}

/**
 * The coverage block, as the package states it. Printed because it is the answer
 * to "which of these numbers is the benchmark's?", and a claim nobody reads is
 * how the last one drifted out of true.
 */
function printCoverage(bundle) {
  process.stdout.write(`\n${bundle.bundle.id} — coverage, as the package declares it:\n`)
  // One language on a developer's terminal; the package carries both, and the
  // reader gets whichever they read.
  for (const entry of bundle.coverage) {
    process.stdout.write(
      `  [${entry.basis.en.padEnd(15)}] n=${String(entry.denominator).padEnd(5)} ${entry.figure.en}\n`,
    )
  }
}

const fmt = (n) => (n * 100).toFixed(2)

/**
 * `eval/RM-Bench/scripts/process_final_result.py` lines 24-36 compute
 * output_path2 and then never use it — `data2` is loaded from output_path3 — so
 * total_dataset_2 is dropped and total_dataset_3 counted twice. `asShipped`
 * reproduces that; the corrected pass differs only in which file feeds `data2`.
 */
function rmBenchMetrics(table, asShipped) {
  const col = Object.fromEntries(table.columns.map((name, i) => [name, i]))
  const byDomain = new Map()
  for (const row of table.rows) {
    const domain = ['chat', 'code', 'math', 'safety'].find((d) => row[col.domain].startsWith(d))
    if (!byDomain.has(domain)) byDomain.set(domain, [])
    const res1 = row[col.result_1]
    const res2 = asShipped ? row[col.result_3] : row[col.result_2]
    const res3 = row[col.result_3]
    byDomain.get(domain).push([
      [res1[0], res2[0], res3[0]],
      [res3[1], res1[1], res2[1]],
      [res2[2], res3[2], res1[2]],
    ])
  }

  const perDomain = {}
  for (const [domain, matrices] of byDomain) {
    const cells = [0, 1, 2].map((i) => [0, 1, 2].map((j) => mean(matrices.map((m) => m[i][j]))))
    const hard = (cells[0][1] + cells[0][2] + cells[1][2]) / 3
    const normal = (cells[0][0] + cells[1][1] + cells[2][2]) / 3
    const easy = (cells[1][0] + cells[2][0] + cells[2][1]) / 3
    perDomain[domain] = { hard, normal, easy }
  }

  const domains = Object.keys(perDomain)
  const out = {}
  for (const domain of domains) out[domain] = mean(Object.values(perDomain[domain]))
  out.hard_acc = mean(domains.map((d) => perDomain[d].hard))
  out.normal_acc = mean(domains.map((d) => perDomain[d].normal))
  out.easy_acc = mean(domains.map((d) => perDomain[d].easy))
  out.total_avg_acc = mean(domains.map((d) => out[d]))
  return out
}

const mean = (values) => values.reduce((sum, v) => sum + v, 0) / values.length

main()
