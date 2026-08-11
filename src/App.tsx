import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Adapter, DemoPackage, ParsedFile, RouteState } from './types'
import { all, demoById, dispatch as dispatchFiles } from './adapters/registry'
import type { Dispatch } from './adapters/registry'
import { DropZone } from './shell/DropZone'
import { ErrorBoundary } from './shell/ErrorBoundary'
import { RecordBrowser } from './shell/RecordBrowser'
import { fileFromBlob, parseFile, parseFiles } from './shell/parseClient'
import type { ParseProgress } from './shell/parseClient'
import {
  buildHref,
  goHome,
  openDemo,
  resolveRoute,
  selectRecord,
  shareUrl,
  useRoute,
} from './shell/router'
import { useLang, useT } from './shell/lang'
import type { Str } from './shell/lang'
import { useTheme } from './shell/theme'
import './App.css'

/**
 * The shell. Files come in from a drop or a `?demo=` link, go through the parse
 * worker, then through dispatch, and land in one of two views: the adapter that
 * claimed them, or the raw record browser.
 *
 * The invariant this file exists to hold: nothing a file or an adapter can do
 * produces a blank page. Parse damage becomes a notice, an unclaimed drop becomes
 * RawTree, and an adapter that throws — in `parse()` or in `render` — is demoted
 * to RawTree with the reason on screen.
 *
 * Every string the shell writes is a `Str`; everything that came out of a file —
 * file names, parse excerpts, error text from the platform — travels through
 * `verbatim()` and is shown in whatever language it arrived in. See `shell/lang.ts`.
 */

/** A phrase in one language only, because it is data: a file name, an excerpt. */
function verbatim(text: string): Str {
  return { en: text, zh: text }
}

/** AgentLens's own words, with the Chinese defaulting to the English when absent. */
function str(en: string, zh?: string): Str {
  return { en, zh: zh ?? en }
}

/**
 * The product's central promise, and the one line that has to be exactly as
 * unambiguous in both languages. The Chinese says the same two things the English
 * does — the data stays here, and nothing leaves — in fewer characters.
 */
const PRIVACY_LINE: Str = {
  en: 'All data stays in your browser — nothing is uploaded.',
  zh: '数据全部留在你的浏览器里，不会上传。',
}
/** Below ~560px the full sentence truncates to nothing useful; the promise itself fits. */
const PRIVACY_SHORT: Str = {
  en: 'Nothing is uploaded.',
  zh: '不会上传任何数据。',
}

/**
 * The one control that has to read correctly in a language the reader may not
 * have yet, so it is labelled with the language it switches *to* and describes
 * itself in the language currently on screen.
 */
const LANG_SWITCH: Str = {
  en: 'Switch the interface to Chinese',
  zh: '将界面切换为英文',
}

/* ---------------------------------------------------------------- countables */

/** English pluralises, Chinese takes a measure word; the numeral is the same. */
interface Noun {
  one: string
  many: string
  zh: string
}

const FILES: Noun = { one: 'file', many: 'files', zh: '个文件' }
const RECORDS: Noun = { one: 'record', many: 'records', zh: '条记录' }
const PROBLEMS: Noun = { one: 'problem', many: 'problems', zh: '处问题' }
const DAMAGED: Noun = { one: 'damaged file', many: 'damaged files', zh: '个损坏的文件' }
const MALFORMED: Noun = { one: 'malformed line', many: 'malformed lines', zh: '行无法解析的内容' }

function countOf(n: number, noun: Noun): Str {
  const numeral = n.toLocaleString()
  return { en: `${numeral} ${n === 1 ? noun.one : noun.many}`, zh: `${numeral} ${noun.zh}` }
}

/* ------------------------------------------------------------ landing cards */

/**
 * Chinese for the strings the *registry* supplies. An adapter publishes one blurb
 * and one label, in English (`types.ts`), and rewriting somebody else's
 * description of their own system is not this file's business; carrying the
 * Chinese for it, keyed by the id they registered under, is. Anything without an
 * entry falls back to the English, which is the honest failure mode: an adapter's
 * own words untranslated beat a guess at what their system does.
 */
const ZH_ADAPTER: Record<string, { label?: string; blurb?: string }> = {
  // No `blurb`: both of this adapter's cards are described by DEMO_BLURB below,
  // so a Chinese line here would be a translation of a sentence nothing renders.
  // The English one in `adapters/rm-r1/index.ts` is the adapter's own to keep true.
  'rm-r1': {
    label: 'RM-R1 奖励模型判例',
  },
  // Same reason as rm-r1: both PromptWise cards are described by DEMO_BLURB, so
  // a Chinese blurb here would translate a sentence nothing renders.
  promptwise: {
    label: 'PromptWise 成本感知路由',
  },
  // No `blurb`, for the same reason as rm-r1 and promptwise: this adapter's one
  // card is described by DEMO_BLURB below, in both languages at once. It used to
  // carry a Chinese sentence built on `counts.flagged` — "105 个里有 66 个至少
  // 触发了一条策略" — which is the number the package itself now says is not a
  // detection rate, and a landing card is exactly where such a number gets
  // screenshotted out of everything that qualifies it.
  arbiteros: {
    label: 'ArbiterOS 策略重放',
  },
  'arbiteros-preview': {
    label: 'ArbiterOS 红队用例',
    blurb: '每个用例：智能体在此之前看到过什么，以及它即将做出的决策。',
  },
}

const ZH_DEMO: Record<string, string> = {
  'rm-r1': 'RM-R1 判例日志 · 32B',
  'rm-r1-compare': 'RM-R1 运行对比 · 两个 32B 检查点',
  // The two PromptWise packages differ only in one thing — whether the models
  // differ in competence — and that difference is the whole demo, so it is what
  // each label says. Neither is named after its file.
  'promptwise-tiered': 'PromptWise 路由 · 价格与能力不一致的模型',
  'promptwise-uniform': 'PromptWise 路由 · 每个模型成功率都一样',
  // Both ArbiterOS labels say 全部 105 and not 样本, for the same reason the
  // English says "all 105": each package covers every case file upstream ships,
  // so calling either a sample would be a claim about a selection that was never
  // made. What separates them is the artifact — 重放 against 原始用例文件.
  arbiteros: 'ArbiterOS 策略重放 · 全部 105 个红队用例、500 条指令',
  'arbiteros-preview': 'ArbiterOS 红队用例 · 全部 105 条',
}

/**
 * An adapter's blurb describes the adapter. When one adapter ships several demo
 * packages, that blurb is the same sentence on every card, and it has to be true
 * of all of them at once — which is how a card ends up saying something no
 * package does. These describe the *package*, in both languages, and only where
 * the two differ enough to need it; a demo with no entry keeps the adapter's own
 * sentence, which is right when the adapter has exactly one package.
 *
 * The line these replaced said the benchmark scores were "recomputed from those
 * same records" — the sampled judgements the same sentence had just enumerated.
 * They are not: a figure that carries a benchmark's name is computed from the
 * complete outcome table the package also carries, over every record in the run.
 * Saying otherwise on the landing page understated the demo and misdescribed it.
 */
const DEMO_BLURB: Record<string, Str> = {
  'rm-r1': {
    en: 'One 32B checkpoint, all four log families: sampled judgements to read with their rubrics, evidence and verdicts, and RewardBench and RM-Bench scores recomputed from the complete outcome tables — all 2,985 and all 1,327 records, not the sample.',
    zh: '一个 32B 检查点，四类日志俱全：可以逐条细读的判例，连同评分细则、引证与判定；RewardBench 与 RM-Bench 的分数由完整结果表重算——全部 2,985 条与全部 1,327 条，不是这份样本。',
  },
  // Every figure below was read out of the shipped package, not remembered: the
  // finals are `run.final.utility` as the file prints them, the escalation count
  // is the `escalated` flag over the steps the package actually carries, and the
  // share is `visitation`. Both cards say the data is invented, because a
  // landing card is where a number gets screenshotted out of its context.
  'promptwise-tiered': {
    en: 'Five models priced 0.75 to 12.50, and a success table in which the cheapest is also the weakest — the world where paying more can be worth it. Eight routers over 1,000 steps × 20 epochs: PromptWise ends at 0.70214 mean utility against 0.25800 for always-cheapest and 0.24865 for always-dearest, and 37 of its 134 sampled steps end on a model dearer than the one they started with. The data is invented, success rates and all.',
    zh: '五个模型，价格从 0.75 到 12.50，而成败表里最便宜的那个恰好也最弱——这正是多花钱可能划算的世界。八个路由器各跑 1,000 步 × 20 个 epoch：PromptWise 收在 0.70214 的平均效用，一直用最便宜的是 0.25800，一直用最贵的是 0.24865；它被抽样的 134 步里，有 37 步最后调用的模型比第一次更贵。数据是造出来的，连成功率也是。',
  },
  'promptwise-uniform': {
    en: "The same eight routers on upstream's own setup, where every model succeeds about equally often however much it costs — so no model is worth escalating to, and the right answer is to settle on the cheapest and retry it. PromptWise ends at 0.86339 mean utility against 0.47765 for always-cheapest and −0.13290 for always-dearest, sending 98.018% of its calls to the 0.75 model. Invented data too, and the case where the mechanism buys nothing.",
    zh: '同样这八个路由器，跑在上游自己的设定上：不管多贵，每个模型成功的概率都差不多——于是没有哪个模型值得升级过去，正确答案就是认准最便宜的那个反复重试。PromptWise 收在 0.86339 的平均效用，一直用最便宜的是 0.47765，一直用最贵的是 −0.13290；它 98.018% 的调用都给了那个 0.75 的模型。数据同样是造出来的，这一份展示的是这套机制无利可图时的样子。',
  },
  // The one ArbiterOS replay package. Its adapter's own English blurb quotes
  // `counts.flagged` — 66 — as the number of cases that trip a policy, and the
  // package's `how_to_read_the_counts` now says in as many words that flagged is
  // not a detection rate: 65 of the 66 are `UnaryGatePolicy` re-serialising a
  // tool call's arguments, and 0 of the 65 change the response. So the card is
  // described here instead, from the three numbers that survive being read
  // literally, each with the same denominator: 39 of 105 cases where a policy
  // produced a refusal, 1 of those actually rewritten, 9 of 105 carrying a
  // lowered trust label. Every one of them is counted out of the package's own
  // records in the runner's README, and the two READMEs say the same sentence.
  arbiteros: {
    en: "All 105 of ArbiterOS's red-team cases, replayed offline through ArbiterOS's own policy kernel — 500 instructions, and no model is called. A policy produced a refusal on 39 of the 105 — 21 of the 45 cases the suite labels unsafe and 18 of the 60 it labels safe. One response was actually rewritten; the other 38 refusals were recorded and then dropped, because policy_registry.json registers 11 of its 15 policies observe-only. 9 of the 105 carry an instruction whose propagated trust is LOW, and the graph names the earlier step that lowered it.",
    zh: 'ArbiterOS 自己的全部 105 个红队用例，放回 ArbiterOS 自己的策略内核里离线重放——500 条 instruction，全程不调用模型。105 个里有 39 个产生了策略拒绝——套件标为 unsafe 的 45 个里占 21 个，标为 safe 的 60 个里占 18 个。其中 1 个的响应真的被改写，另外 38 个的拒绝被记录下来之后丢掉，因为 policy_registry.json 把 15 条策略里的 11 条注册成只观察。105 个里有 9 个含有传播后可信度为 LOW 的 instruction，而那张图会点出是更早的哪一步把它压下来的。',
  },
  'rm-r1-compare': {
    en: 'Two 32B checkpoints on the same RewardBench items: how often they agree over all 2,985, where they move apart by subset, and 40 judgements side by side — each one either answered differently or missed by both. Every score stays beside the run it belongs to.',
    zh: '两个 32B 检查点在同一批 RewardBench 题目上：全部 2,985 条上两边有多一致、按子集看在哪里拉开，以及 40 条判例并排对读——每一条要么两边判得不同，要么两边都判错。每个分数都留在它所属的运行旁边。',
  },
}

function adapterLabel(adapter: Adapter): Str {
  return str(adapter.label, ZH_ADAPTER[adapter.name]?.label)
}

function adapterBlurb(adapter: Adapter): Str {
  return str(adapter.blurb, ZH_ADAPTER[adapter.name]?.blurb)
}

function cardBlurb(adapter: Adapter, demo: DemoPackage): Str {
  return DEMO_BLURB[demo.id] ?? adapterBlurb(adapter)
}

function demoLabel(demo: DemoPackage): Str {
  return str(demo.label, ZH_DEMO[demo.id])
}

/**
 * A roadmap row: an adapter that is *not* in this build. Live cards are derived
 * from the registry instead (see `landingCards`), so registering an adapter is
 * the only thing needed to put it on the landing page — including adapters that
 * appear on no roadmap row at all.
 */
interface Planned {
  /** The `?demo=` id, and the adapter name, the real adapter will publish. */
  id: string
  label: string
  blurb: Str
  stage: string
  /**
   * Shown on the card of an adapter that shares this row without *being* it
   * (`<row>-<suffix>`). While the row itself is unbuilt that card is a partial
   * view and the note has to say what it does not do yet; once the row ships,
   * two cards stand side by side and the note has to say which artifact this one
   * opens instead. Either way it is the sentence that keeps the pair from
   * reading as one thing shown twice. Unused while nothing shares the row.
   */
  previewNote?: Str
}

const PLANNED: Planned[] = [
  {
    id: 'rm-r1',
    label: 'RM-R1',
    blurb: {
      en: 'Reward-model evaluation runs: per-example verdicts, and where the judge and the label disagree.',
      zh: '奖励模型的评测运行：逐条样本的判定，以及评审模型与数据集标注不一致的地方。',
    },
    stage: 'M1',
  },
  {
    id: 'promptwise',
    label: 'PromptWise',
    blurb: {
      en: 'Cost-aware model routing: which model answered each prompt, when it escalated to a more expensive one, and what that cost.',
      zh: '按成本调度的模型路由：每条 prompt 交给哪个模型作答、什么时候升级到更贵的模型，以及为此花了多少。',
    },
    stage: 'M2',
  },
  {
    id: 'arbiteros',
    label: 'ArbiterOS',
    blurb: {
      en: 'Agent red-team cases replayed through the policy kernel: which policies fired, which response was rewritten, and where each instruction inherited its security labels from.',
      zh: '把智能体红队用例灌进策略内核重放：哪些策略触发了、哪一次响应被改写，以及每条指令的安全标签是从哪一步继承来的。',
    },
    stage: 'M3',
    // M3 ships, so this note no longer says what is missing — it says which of
    // the two ArbiterOS cards this one is. `arbiteros-preview` was not retired:
    // the case files and a replay of them are different artifacts, the raw files
    // are the only thing on this site no kernel has touched, and every
    // `?demo=arbiteros-preview` link already mailed still opens what it named.
    previewNote: {
      en: 'The case files as upstream ships them, one per row, before any replay — nothing here has been through a kernel. The replay, with the policy verdicts and the label propagation, is the ArbiterOS policy replay card.',
      zh: '上游发布时的原始用例文件，一行一条，未经任何重放——这里的内容没有被内核碰过。重放本身，连同策略判决与标签传播，在「ArbiterOS 策略重放」那张卡片里。',
    },
  },
  {
    id: 'recmem',
    label: 'RecMem',
    blurb: {
      en: 'Memory stores over time: what was written, what was retrieved, and what went stale.',
      zh: '记忆库随时间的变化：写入了什么、检索到了什么，以及哪些已经过时。',
    },
    stage: 'M4',
  },
]

/**
 * An adapter named `<row>` *is* that roadmap row; one named `<row>-<suffix>`
 * (`arbiteros-preview`) is a preview of it. Either way the row is replaced by
 * the working card, so the landing page can never advertise a milestone as
 * unbuilt next to a card that opens it.
 */
function plannedFor(adapterName: string): Planned | undefined {
  return PLANNED.find((row) => adapterName === row.id || adapterName.startsWith(`${row.id}-`))
}

interface Card {
  key: string
  label: Str
  blurb: Str
  badge: Str
  /** Set only when the card opens something. */
  demoId?: string
  note?: Str
  planned?: boolean
}

function landingCards(adapters: Adapter[]): Card[] {
  const live = adapters.flatMap((adapter): Card[] => {
    const row = plannedFor(adapter.name)
    const note = row && adapter.name !== row.id ? row.previewNote : undefined
    const demos = adapter.demos ?? []
    if (demos.length === 0) {
      return [
        {
          key: adapter.name,
          label: adapterLabel(adapter),
          blurb: adapterBlurb(adapter),
          badge: { en: 'no demo package', zh: '没有演示数据包' },
          note: {
            en: 'Registered in this build — drop matching logs below and it takes over.',
            zh: '本构建里已注册：把匹配的日志拖到下面，就由它接管。',
          },
        },
      ]
    }
    return demos.map((demo) => ({
      key: `${adapter.name}:${demo.id}`,
      // The card names the package it opens, never the adapter that reads it —
      // even when the adapter ships exactly one. A package label carries what the
      // adapter's cannot: `ArbiterOS red-team cases · all 105` says the demo is
      // the whole upstream suite rather than a selection from it, and borrowing
      // the adapter's label dropped that count until after the card was clicked.
      // It is also the title the reader lands on, so the two now match.
      label: demoLabel(demo),
      blurb: cardBlurb(adapter, demo),
      badge: { en: 'Open demo', zh: '打开演示' },
      demoId: demo.id,
      note,
    }))
  })

  const covered = new Set(adapters.map((adapter) => plannedFor(adapter.name)?.id))
  const planned = PLANNED.filter((row) => !covered.has(row.id)).map(
    (row): Card => ({
      key: row.id,
      label: verbatim(row.label),
      blurb: row.blurb,
      badge: { en: `${row.stage} · planned`, zh: `${row.stage} · 规划中` },
      note: { en: 'No adapter in this build yet.', zh: '本构建里还没有对应的适配器。' },
      planned: true,
    }),
  )

  return [...live, ...planned]
}

/* -------------------------------------------------------------------- state */

interface Dataset {
  /** `demo:<id>` or `drop:<n>` — identifies what is loaded without comparing files. */
  key: string
  title: Str
  /**
   * Set only for a demo package. A dropped file has no URL anyone else can open,
   * so there is no link to copy for it.
   */
  demoId?: string
  /** Who produced a demo package's data. Travels with the package; see types.ts. */
  credit?: DemoPackage['credit']
  files: ParsedFile[]
  dispatch: Dispatch
  /** Undefined when nobody claimed the data, or when the claimant failed. */
  adapter?: Adapter
  model?: unknown
  /** Things the reader has to know that dispatch itself did not report. */
  notes: Str[]
}

interface Progress extends ParseProgress {
  fileName: string
  fileIndex: number
  fileCount: number
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'busy'; title: Str; progress: Progress | null }
  | { kind: 'failed'; title: Str; message: Str }
  | { kind: 'ready'; dataset: Dataset }

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function buildDataset(
  source: { key: string; title: Str; demoId?: string; credit?: DemoPackage['credit'] },
  files: ParsedFile[],
  preferred?: Adapter,
): Dataset {
  const dispatch = dispatchFiles(files)
  const notes: Str[] = []
  let adapter = dispatch.adapter

  if (!adapter && preferred) {
    // A demo package that no longer matches its own adapter's fingerprint is a
    // bug worth showing, but not a reason to drop the reader into RawTree.
    adapter = preferred
    notes.push({
      en: `This package ships with the ${preferred.label} view, but its records no longer match that adapter's fingerprint. Opening it anyway.`,
      zh: `这个数据包附带 ${adapterLabel(preferred).zh} 视图，但它的记录已经不再匹配该适配器的指纹。仍然用这个视图打开。`,
    })
  }

  let model: unknown
  if (adapter) {
    try {
      model = adapter.parse(files)
    } catch (error) {
      const reason = messageOf(error)
      notes.push({
        en: `${adapter.label} could not read these files (${reason}). Showing the raw records instead.`,
        zh: `${adapterLabel(adapter).zh} 读不了这些文件（${reason}）。改为显示原始记录。`,
      })
      adapter = undefined
    }
  }

  return { ...source, files, dispatch, adapter, model, notes }
}

/* ---------------------------------------------------------------------- app */

function App() {
  const route = useRoute()
  const { theme, toggle: toggleTheme } = useTheme()
  const { lang, toggle: toggleLang, t } = useLang()
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })

  const resolved = useMemo(() => resolveRoute(route, knownDemoIds()), [route])

  // What is loaded, tracked outside React state so the demo effect can tell a
  // repeat of the same route from a real change without re-running on every render.
  const loadedKey = useRef<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const runId = useRef(0)
  const dropCount = useRef(0)

  const startLoad = useCallback((key: string, title: Str) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    loadedKey.current = key
    const token = ++runId.current
    setPhase({ kind: 'busy', title, progress: null })
    return { controller, current: () => token === runId.current }
  }, [])

  const reset = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    runId.current += 1
    loadedKey.current = null
    setPhase({ kind: 'idle' })
  }, [])

  const handleFiles = useCallback(
    async (files: File[]) => {
      dropCount.current += 1
      const key = `drop:${dropCount.current}`
      // One file is named; several are counted. The name itself is never translated.
      const title = files.length === 1 ? verbatim(files[0].name) : countOf(files.length, FILES)
      const { controller, current } = startLoad(key, title)
      // A drop replaces whatever the URL pointed at; the old `?record=` is meaningless now.
      goHome({ replace: true })

      try {
        const parsed = await parseFiles(files, {
          signal: controller.signal,
          onProgress: (file, progress) => {
            if (!current()) return
            setPhase((previous) =>
              previous.kind === 'busy'
                ? {
                    ...previous,
                    progress: {
                      ...progress,
                      fileName: file.name,
                      fileIndex: files.indexOf(file),
                      fileCount: files.length,
                    },
                  }
                : previous,
            )
          },
        })
        if (!current()) return
        setPhase({ kind: 'ready', dataset: buildDataset({ key, title }, parsed) })
      } catch (error) {
        if (!current() || controller.signal.aborted) return
        setPhase({ kind: 'failed', title, message: verbatim(messageOf(error)) })
      }
    },
    [startLoad],
  )

  const loadDemo = useCallback(
    async (adapter: Adapter, demo: DemoPackage) => {
      const key = `demo:${demo.id}`
      const label = demoLabel(demo)
      const { controller, current } = startLoad(key, label)

      try {
        const response = await fetch(demoUrl(demo.path), { signal: controller.signal })
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
        const blob = await response.blob()
        if (!current()) return
        const parsed = await parseFile(fileFromBlob(blob, fileNameOf(demo.path)), {
          signal: controller.signal,
          onProgress: (progress) => {
            if (!current()) return
            setPhase((previous) =>
              previous.kind === 'busy'
                ? {
                    ...previous,
                    progress: {
                      ...progress,
                      fileName: fileNameOf(demo.path),
                      fileIndex: 0,
                      fileCount: 1,
                    },
                  }
                : previous,
            )
          },
        })
        if (!current()) return
        setPhase({
          kind: 'ready',
          dataset: buildDataset(
            { key, title: label, demoId: demo.id, credit: demo.credit },
            [parsed],
            adapter,
          ),
        })
      } catch (error) {
        if (!current() || controller.signal.aborted) return
        const reason = messageOf(error)
        setPhase({
          kind: 'failed',
          title: label,
          message: {
            en: `Could not load this demo package (${reason}). Dropping your own files still works.`,
            zh: `这个演示数据包加载不了（${reason}）。拖入你自己的文件仍然可用。`,
          },
        })
      }
    },
    [startLoad],
  )

  useEffect(() => {
    const id = resolved.demo
    if (id === undefined) {
      // Back out of a demo (Back button, or an unknown `?demo=`) returns to landing.
      if (loadedKey.current?.startsWith('demo:')) reset()
      return
    }
    if (loadedKey.current === `demo:${id}`) return
    const found = demoById(id)
    if (found) void loadDemo(found.adapter, found.demo)
  }, [resolved.demo, loadDemo, reset])

  const leaveDataset = useCallback(() => {
    reset()
    goHome()
  }, [reset])

  const themeSwitch: Str =
    theme === 'dark'
      ? { en: 'Switch to light theme', zh: '切换到浅色主题' }
      : { en: 'Switch to dark theme', zh: '切换到深色主题' }

  return (
    <div className="app">
      <header className="topbar">
        <button type="button" className="ghost brand" onClick={leaveDataset}>
          AgentLens
        </button>
        <span className="spacer" />
        <span className="privacy truncate">
          <span className="privacy-full">{t(PRIVACY_LINE)}</span>
          <span className="privacy-short">{t(PRIVACY_SHORT)}</span>
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="icon"
          onClick={toggleTheme}
          title={t(themeSwitch)}
          aria-label={t(themeSwitch)}
        >
          {theme === 'dark' ? '☀' : '☾'}
        </button>
        <button
          type="button"
          className="lang-toggle"
          onClick={toggleLang}
          title={t(LANG_SWITCH)}
          aria-label={t(LANG_SWITCH)}
        >
          {/* The label is written in the language it switches to, so it is marked
              as such — the aria-label stays in the document's language. */}
          <span lang={lang === 'zh' ? 'en' : 'zh-Hans'}>{lang === 'zh' ? 'EN' : '中文'}</span>
        </button>
      </header>

      <main className="app-main">
        {phase.kind === 'ready' ? (
          <DatasetView dataset={phase.dataset} recordId={resolved.record} onClose={leaveDataset} />
        ) : phase.kind === 'busy' ? (
          <Loading title={phase.title} progress={phase.progress} />
        ) : (
          <Landing
            failure={phase.kind === 'failed' ? phase : undefined}
            unknownDemo={resolved.unknownDemo}
            orphanRecord={resolved.demo === undefined ? resolved.record : undefined}
            onFiles={handleFiles}
          />
        )}
      </main>

      <footer className="statusbar">
        <StatusBar phase={phase} />
      </footer>
    </div>
  )
}

export default App

/* ------------------------------------------------------------------ landing */

interface LandingProps {
  failure?: { title: Str; message: Str }
  unknownDemo?: string
  orphanRecord?: string
  onFiles: (files: File[]) => void
}

function Landing({ failure, unknownDemo, orphanRecord, onFiles }: LandingProps) {
  const t = useT()

  return (
    <div className="scroll fill">
      <div className="container stack landing">
        <div className="stack">
          <h1>AgentLens</h1>
          <p className="lead">
            {t({
              en: 'One viewer for the artifacts LLM and agent research leaves behind — evaluation logs, agent traces, memory stores, router decisions. Nothing is installed and nothing is uploaded: the files are read in this tab.',
              zh: '一个查看器，读 LLM 与智能体研究留下的各种产物：评测日志、智能体轨迹、记忆库、路由决策。不用安装，也不会上传，文件都在这个标签页里读取。',
            })}
          </p>
        </div>

        {unknownDemo !== undefined && (
          <p className="notice warn">
            {t({
              en: `This link asks for a demo called “${unknownDemo}”, which this build does not have. It is probably from a later milestone.`,
              zh: `这个链接要打开名为「${unknownDemo}」的演示，本构建里没有它，多半来自后面的里程碑。`,
            })}
          </p>
        )}
        {orphanRecord !== undefined && (
          <p className="notice">
            {t({
              en: `This link points at record “${orphanRecord}”. Open a demo or drop the matching file and it will be selected.`,
              zh: `这个链接指向记录「${orphanRecord}」。打开一个演示，或拖入对应的文件，它就会被选中。`,
            })}
          </p>
        )}
        {failure && (
          <p className="notice bad">
            {t(failure.title)}
            {t({ en: ': ', zh: '：' })}
            {t(failure.message)}
          </p>
        )}

        <section className="stack">
          <h2>{t({ en: 'Open a demo', zh: '打开一个演示' })}</h2>
          <div className="card-grid">
            {landingCards(all()).map((card) => (
              <DemoCard key={card.key} card={card} />
            ))}
          </div>
        </section>

        <section className="stack">
          <h2>{t({ en: 'Or read your own', zh: '或者读你自己的日志' })}</h2>
          <DropZone
            onFiles={onFiles}
            heading={{ en: 'Drop logs here', zh: '把日志拖到这里' }}
            hint={t({
              en: 'JSON, JSONL, one file or a folder. Damaged files are salvaged as far as they go.',
              zh: 'JSON、JSONL，单个文件或整个文件夹。损坏的文件会尽量抢救解析。',
            })}
          />
        </section>
      </div>
    </div>
  )
}

function DemoCard({ card }: { card: Card }) {
  const t = useT()
  const body = (
    <>
      <span className="cluster card-head">
        <strong>{t(card.label)}</strong>
        <span className="spacer" />
        <span className={card.demoId === undefined ? 'badge' : 'badge info'}>{t(card.badge)}</span>
      </span>
      <span className="small muted">{t(card.blurb)}</span>
      {card.note !== undefined && <span className="small faint">{t(card.note)}</span>}
    </>
  )

  if (card.demoId === undefined) {
    return <div className={card.planned ? 'card is-planned' : 'card'}>{body}</div>
  }

  const demoId = card.demoId
  return (
    <a
      className="card"
      href={buildHref({ demo: demoId })}
      onClick={(event) => {
        // Left click routes in place; modified clicks stay real link clicks.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
        event.preventDefault()
        openDemo(demoId)
      }}
    >
      {body}
    </a>
  )
}

/* ------------------------------------------------------------------ loading */

function Loading({ title, progress }: { title: Str; progress: Progress | null }) {
  const t = useT()
  const pct =
    progress && progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.bytesRead / progress.totalBytes) * 100))
      : 0
  const name = t(title)

  return (
    <div className="scroll fill">
      <div className="container stack loading">
        <h2>{t({ en: `Reading ${name}`, zh: `正在读取 ${name}` })}</h2>
        <div
          className="progress"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={t({ en: `Parsing ${name}`, zh: `正在解析 ${name}` })}
        >
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <p className="small muted">
          {progress
            ? t({
                en:
                  `${formatBytes(progress.bytesRead)} of ${formatBytes(progress.totalBytes)} · ${countOf(progress.recordCount, RECORDS).en}` +
                  (progress.fileCount > 1
                    ? ` · file ${progress.fileIndex + 1} of ${progress.fileCount} (${progress.fileName})`
                    : ''),
                zh:
                  `${formatBytes(progress.bytesRead)} / ${formatBytes(progress.totalBytes)} · ${countOf(progress.recordCount, RECORDS).zh}` +
                  (progress.fileCount > 1
                    ? ` · 第 ${progress.fileIndex + 1} / ${progress.fileCount} 个文件（${progress.fileName}）`
                    : ''),
              })
            : t({ en: 'Starting the parse worker…', zh: '正在启动解析 worker…' })}
        </p>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ dataset */

interface DatasetViewProps {
  dataset: Dataset
  recordId?: string
  onClose: () => void
}

function DatasetView({ dataset, recordId, onClose }: DatasetViewProps) {
  const t = useT()
  const { adapter, dispatch, files } = dataset
  const fallback = (
    <RecordBrowser files={files} recordId={recordId} onSelect={(id) => selectRecord(id)} />
  )
  const match = Math.round(dispatch.confidence * 100)

  return (
    <div className="dataset">
      <div className="cluster dataset-head">
        <strong className="truncate">{t(dataset.title)}</strong>
        {adapter ? (
          <span className="badge info">
            {t(adapterLabel(adapter))}
            {dispatch.outcome === 'declared'
              ? t({ en: ' · declared', zh: ' · 已声明' })
              : t({ en: ` · ${match}% match`, zh: ` · ${match}% 匹配` })}
          </span>
        ) : (
          <span className="badge">{t({ en: 'Raw records', zh: '原始记录' })}</span>
        )}
        <span className="spacer" />
        {dataset.demoId !== undefined && (
          <CopyLink route={{ demo: dataset.demoId, record: recordId }} />
        )}
        <button type="button" className="ghost" onClick={onClose}>
          {t({ en: 'Close', zh: '关闭' })}
        </button>
      </div>

      {dataset.credit && (
        <p className="dataset-credit">
          {/* The credit itself is the data's own attribution line and stays as the
              package wrote it; only the word introducing it is ours. */}
          {t({ en: 'Data: ', zh: '数据来源：' })}
          {dataset.credit.href ? (
            <a href={dataset.credit.href} target="_blank" rel="noreferrer noopener">
              {dataset.credit.text}
            </a>
          ) : (
            dataset.credit.text
          )}
        </p>
      )}

      <div className="dataset-notices stack">
        <ParseNotices files={files} />
        {/* A dispatch warning is AgentLens's own sentence about a file, so it is a
            `Str` and is translated here; the file name inside it stays verbatim,
            which is why the key is keyed off the English side rather than the
            rendered one — the identity of a warning must not change with the
            language the reader happens to be in. */}
        {dispatch.warnings.map((warning) => (
          <p key={warning.kind + warning.message.en} className="notice warn">
            {t(warning.message)}
          </p>
        ))}
        {dataset.notes.map((note) => (
          <p key={note.en} className="notice bad">
            {t(note)}
          </p>
        ))}
        {!adapter && dispatch.outcome === 'unclaimed' && (
          <p className="notice">
            {t({
              en:
                'No adapter recognised this data' +
                (dispatch.scores.length > 0 && dispatch.confidence > 0
                  ? ` (best guess ${dispatch.scores[0].name} at ${match}%)`
                  : '') +
                '. Showing the records as they were parsed.',
              zh:
                '没有适配器认领这批数据' +
                (dispatch.scores.length > 0 && dispatch.confidence > 0
                  ? `（最接近的是 ${dispatch.scores[0].name}，${match}%）`
                  : '') +
                '。按解析出来的样子直接显示记录。',
            })}
          </p>
        )}
        {!adapter && <RawScopeNote />}
      </div>

      <div className="dataset-body">
        {adapter ? (
          <ErrorBoundary
            resetKey={dataset.key}
            fallback={(error) => (
              <div className="dataset-fallback">
                <p className="notice bad">
                  {t({
                    en: `The ${adapter.label} view crashed (${error.message}). Falling back to the raw records.`,
                    zh: `${adapterLabel(adapter).zh} 视图崩溃了（${error.message}）。回退到原始记录。`,
                  })}
                </p>
                <RawScopeNote />
                {fallback}
              </div>
            )}
          >
            <div className="scroll fill adapter-view">
              <adapter.View model={dataset.model} recordId={recordId} />
            </div>
          </ErrorBoundary>
        ) : (
          fallback
        )}
      </div>
    </div>
  )
}

/**
 * The raw browser shows a dropped file field for field, so it will happily print
 * a checkpoint name that the RM-R1 adapter drops. Both behaviours are right, and
 * the promise is what had to be narrowed: AgentLens redacts what it *ships*, not
 * what it shows you of your own file. This says so where the raw records are, in
 * the same words as the README and the adapter's own note, so a reader who meets
 * the claim in one place and the tree in another is not caught by a contradiction.
 */
function RawScopeNote() {
  const t = useT()
  return (
    <p className="notice">
      {t({
        en: 'This is your own file, read in this tab and shown exactly as it arrived: AgentLens hides nothing here, and nothing is uploaded. Redaction is a rule about what AgentLens ships — its demo packages drop the fields that name an internal checkpoint, and no such name appears anywhere on the published site.',
        zh: '这是你自己的文件，在这个标签页里读取，原样显示：AgentLens 在这里不隐藏任何字段，也不会上传任何内容。脱敏针对的是 AgentLens 发布的东西：它的演示数据包会去掉写有内部检查点名称的字段，已发布的站点上不会出现这样的名称。',
      })}
    </p>
  )
}

/**
 * The deep link is how this project reaches people, so it is copyable from the
 * page rather than only from the address bar: whatever record is open is in the
 * URL, and this hands that URL over in one click.
 */
function CopyLink({ route }: { route: RouteState }) {
  const t = useT()
  const url = shareUrl(route)
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')

  // Selecting another record makes the copied link stale; say so by resetting.
  useEffect(() => setState('idle'), [url])

  return (
    <button
      type="button"
      className="ghost copy-link"
      title={url}
      aria-live="polite"
      onClick={() => {
        // There is no clipboard on an insecure origin, and the user may refuse
        // permission: both land here, and neither is worth an error dialog.
        void (async () => {
          try {
            await navigator.clipboard.writeText(url)
            setState('copied')
          } catch {
            setState('failed')
          }
        })()
      }}
    >
      {state === 'copied'
        ? t({ en: 'Link copied', zh: '链接已复制' })
        : state === 'failed'
          ? t({ en: 'Copy failed — the link is in the address bar', zh: '复制失败，链接就在地址栏里' })
          : t({ en: 'Copy link', zh: '复制链接' })}
    </button>
  )
}

/** Counts first, then the first few excerpts — a damaged file must not look clean. */
function ParseNotices({ files }: { files: ParsedFile[] }) {
  const t = useT()
  // A file the parser could not open at all is not flagged `salvaged` — there was
  // nothing to salvage — but it is the most damaged file there is, and reporting
  // it as "1 malformed line skipped" understates it. Yielding no record while
  // reporting a problem is the same damage by another route.
  const damaged = files.filter(
    (file) => file.salvaged || (file.records.length === 0 && file.problems.length > 0),
  )
  const problems = files.flatMap((file) =>
    file.problems.map((problem) => ({ file: file.fileName, ...problem })),
  )
  if (damaged.length === 0 && problems.length === 0) return null

  // Only what came out of the damaged files, so the count matches the claim.
  const rescued = damaged.reduce((total, file) => total + file.records.length, 0)

  return (
    <div className={`notice ${rescued === 0 && damaged.length > 0 ? 'bad' : 'warn'} stack problems`}>
      <span>{t(damageSummary(damaged.length, problems.length, rescued))}</span>
      {problems.slice(0, 3).map((problem) => (
        <span key={`${problem.file}:${problem.at}:${problem.excerpt.en}`} className="small mono">
          {/* The file name and the offset are the file's own; the reason is ours. */}
          {problem.file} @ {problem.at} · {t(problem.excerpt)}
        </span>
      ))}
      {problems.length > 3 && (
        <span className="small">
          {t({
            en: `…and ${(problems.length - 3).toLocaleString()} more.`,
            zh: `……还有 ${(problems.length - 3).toLocaleString()} 处。`,
          })}
        </span>
      )}
    </div>
  )
}

function damageSummary(damagedFiles: number, problems: number, records: number): Str {
  if (damagedFiles === 0) {
    const lines = countOf(problems, MALFORMED)
    return { en: `${lines.en} skipped.`, zh: `跳过了 ${lines.zh}。` }
  }
  if (records === 0) {
    const from = countOf(damagedFiles, FILES)
    return {
      en: `Nothing could be read from ${from.en} — this does not look like JSON or JSONL.`,
      zh: `从 ${from.zh}中什么都读不出来，这看起来不是 JSON 或 JSONL。`,
    }
  }
  const kept = countOf(records, RECORDS)
  const broken = countOf(damagedFiles, DAMAGED)
  const found = countOf(problems, PROBLEMS)
  return {
    en: `Recovered ${kept.en} from ${broken.en} — the JSON was not valid. ${found.en} found.`,
    zh: `从 ${broken.zh}中抢救出 ${kept.zh}，JSON 不合法。发现 ${found.zh}。`,
  }
}

/* ---------------------------------------------------------------- statusbar */

function StatusBar({ phase }: { phase: Phase }) {
  const t = useT()
  if (phase.kind !== 'ready') {
    return (
      <span>
        {phase.kind === 'busy'
          ? t({ en: 'Parsing…', zh: '正在解析…' })
          : t({ en: 'No data loaded.', zh: '未加载数据。' })}
      </span>
    )
  }
  const { files, dispatch, adapter } = phase.dataset
  const records = files.reduce((total, file) => total + file.records.length, 0)
  const bytes = files.reduce((total, file) => total + file.size, 0)
  const shapes = [...new Set(files.map((file) => file.shape))]

  return (
    <>
      <span>{t(countOf(files.length, FILES))}</span>
      <span>{t(countOf(records, RECORDS))}</span>
      <span>{formatBytes(bytes)}</span>
      {/* Shapes, the adapter's registry name and the dispatch outcome are ids the
          rest of the codebase uses by those spellings, so they are not words to
          translate — the same reason `json-array` beside them is not. */}
      <span className="mono">{shapes.join(', ')}</span>
      <span className="spacer" />
      <span>{adapter ? `${adapter.name} · ${dispatch.outcome}` : 'unclaimed'}</span>
    </>
  )
}

/* ------------------------------------------------------------------ helpers */

function knownDemoIds(): string[] {
  return all().flatMap((adapter) => adapter.demos?.map((demo) => demo.id) ?? [])
}

function demoUrl(path: string): string {
  return new URL(path, new URL(import.meta.env.BASE_URL, window.location.href)).href
}

function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1) || path
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
