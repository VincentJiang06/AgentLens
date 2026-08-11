/**
 * ArbiterOS preview adapter — the seam's proof of life for M0, and the worked
 * example an M1 adapter is meant to be copied from.
 *
 * It reads ArbiterOS red-team cases (`trace_id` + `prior[]` + `current{}`, one
 * case per record) and lists them. The view is deliberately small: M3 replaces
 * it wholesale with the real ArbiterOS trace view, registered under the name
 * `arbiteros`. What must survive M3 is everything around the view — the
 * fingerprint, the model shape, the demo package, and the record-id convention.
 *
 * An adapter is one directory of three parts, and this is the whole manifest:
 *   model.ts   what the format is, and what a view needs from it. Pure — no React.
 *   View.tsx   how it looks. M1..M4 will have several of these.
 *   index.ts   this file: the one object the registry is handed.
 */

import type { Adapter } from '../../types'
import { parse, sniff } from './model'
import type { ArbiterosPreviewModel } from './model'
import { View } from './View'

export type { ArbiterosPreviewModel, RedteamCase } from './model'

/**
 * `name` is the adapter id and `demos[].id` is the `?demo=` value. Both are
 * `arbiteros-preview` so a link mailed today says what it opens, and so it does
 * not collide with the `arbiteros` adapter M3 registers alongside it.
 */
export const arbiterosPreviewAdapter: Adapter<ArbiterosPreviewModel> = {
  name: 'arbiteros-preview',
  label: 'ArbiterOS red-team cases',
  blurb: 'Each case: what the agent had already seen, and the call it was about to make.',
  sniff,
  parse,
  View,
  demos: [
    {
      id: 'arbiteros-preview',
      // Not a sample: `cases.json` is every one of the 105 case files under
      // `ArbiterOS-Kernel/redteam/case/`, and calling the whole suite a sample
      // understates what the card opens. The count is the package's own.
      label: 'ArbiterOS red-team cases · all 105',
      path: 'demo-data/arbiteros-preview/cases.json',
      credit: {
        text: '105 red-team cases from cure-lab/ArbiterOS, Apache-2.0, unmodified',
        href: 'https://github.com/cure-lab/ArbiterOS',
      },
    },
  ],
}
