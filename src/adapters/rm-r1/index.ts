/**
 * RM-R1 adapter — M1.
 *
 * Reads the four log families `eval_one_command.sh` writes (RewardBench,
 * RM-Bench, RMB pairwise, RMB best-of-n) plus the score files beside them, and
 * shows three views of them: the judgements one at a time, the scores
 * recomputed from the records, and two runs against each other.
 *
 * The directory follows the shape `arbiteros-preview` sets out, with the pure
 * half split further because there is more of it:
 *   contract.ts  what the views may assume. Written once, then coded against.
 *   cor.ts       the Chain-of-Rubrics parser. Pure.
 *   metrics.ts   the RM-Bench 3x3 recompute. Pure.
 *   compare.ts   run-to-run alignment. Pure.
 *   model.ts     fingerprint + normalise + assemble. Pure.
 *   *.tsx        the three views, and `View.tsx` which tabs between them.
 *   index.ts     this file: the one object the registry is handed.
 */

import type { Adapter } from '../../types'
import { parse, sniff } from './model'
import type { RmR1Model } from './contract'
import { View } from './View'

export type { RmR1Model } from './contract'

/**
 * `name` must stay exactly `rm-r1`: the landing page matches adapter names
 * against its roadmap rows, so any other name would leave the planned RM-R1
 * card sitting next to this one. It is also the name a demo package declares in
 * `agentlens_format`, which is how a dropped package routes here without
 * fingerprinting — see `shell/sniff.ts`.
 *
 * Both credits are the strings the packages carry in `bundle.credit`, so what
 * the page says about whose data this is and what the file itself says cannot
 * drift apart. Attribution in full, with the licence, is in
 * THIRD_PARTY_NOTICES.md.
 */
export const rmR1Adapter: Adapter<RmR1Model> = {
  name: 'rm-r1',
  label: 'RM-R1 reward-model judgements',
  blurb:
    'Every judgement the reward model wrote, its rubric and its verdict — and the benchmark scores recomputed from those same records.',
  sniff,
  parse,
  View,
  demos: [
    {
      id: 'rm-r1',
      label: 'RM-R1 judgement logs — 32B',
      path: 'demo-data/rm-r1/rm-r1-32b.json',
      credit: {
        text: 'Official RM-R1-Qwen2.5-Instruct-32B evaluation logs from RM-R1-UIUC/RM-R1, Apache-2.0 — a declared sample, records verbatim apart from 1 marked truncation',
        href: 'https://github.com/RM-R1-UIUC/RM-R1',
      },
    },
    {
      id: 'rm-r1-compare',
      label: 'RM-R1 run compare — two 32B checkpoints',
      path: 'demo-data/rm-r1/rm-r1-compare.json',
      credit: {
        text: 'Official RM-R1-Qwen2.5-Instruct-32B and RM-R1-DeepSeek-Distilled-Qwen-32B evaluation logs from RM-R1-UIUC/RM-R1, Apache-2.0 — a declared sample of the items the two runs answer differently, records verbatim',
        href: 'https://github.com/RM-R1-UIUC/RM-R1',
      },
    },
  ],
}
