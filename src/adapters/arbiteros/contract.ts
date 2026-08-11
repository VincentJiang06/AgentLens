/**
 * What the ArbiterOS views need from a policy replay.
 *
 * ArbiterOS governs an agent by parsing every tool call into an *instruction*,
 * labelling it, and propagating those labels along the chain of instructions
 * that produced it. The labels are the interesting object and they are not in
 * any file on disk: a red-team case carries only `trace_id`, `prior` and
 * `current`, and `propTrust`/`propConf` come into existence when the kernel
 * replays it. `scripts/arbiteros-runner/run.py` is that replay — offline, no
 * model, no cost — and this is the shape it writes.
 */

import type { Str } from '../../shell/lang'

/**
 * A security label, before and after propagation.
 *
 * Trust takes the MINIMUM along the reference chain and confidentiality the
 * MAXIMUM: one untrusted upstream makes the whole chain untrusted, one secret
 * upstream makes the whole chain secret. `trust`/`conf` are what this step
 * claims for itself; `propTrust`/`propConf` are what it inherited. When they
 * differ, some ancestor is responsible, and saying which is the point of the
 * graph.
 */
export interface Taint {
  trust?: string
  conf?: string
  propTrust?: string
  propConf?: string
  reversible?: boolean
  risk?: string
  authority?: string
}

/** One instruction: a tool call, or a turn of the agent's own reasoning. */
export interface Step {
  id: string
  /** The instruction this one derives from. Null at the root. */
  parentId: string | null
  /** Position in the replay, 1-based, as the kernel numbered it. */
  step?: number
  /** e.g. `EXECUTION.Human`, `EXECUTION.Env` — the kernel's own vocabulary. */
  category?: string
  type?: string
  /** Prose for a message, serialised JSON for a tool call. Never translated. */
  content: string
  taint: Taint
}

/**
 * What the policy chain concluded — three facts, all different.
 *
 * `wouldBlock` is DETECTION: the kernel's `inactivate_error_type`. A policy
 * judged the response should be stopped, `policy_registry.json` had that policy
 * registered observe-only, so `apply_policy_enforcement_mode`
 * (`arbiteros_kernel/policy_check.py`) put the response back as it was and wrote
 * the message it would have returned here instead. Non-empty means the kernel
 * saw it; the caller still got the original response.
 *
 * `modified`/`errorType` are ENFORCEMENT: the response the caller received was
 * not the one the model produced. This is the smaller number, and reporting it
 * alone describes the shipped registry rather than what the kernel detected.
 *
 * `policies` is neither. A name lands here only when a policy reported it
 * changed the response AND was registered to enforce — an observe-only policy
 * is neutralised before the kernel records its name, which is why every name in
 * the shipped package is one of the four the registry enables. Reporting a
 * change is not the same as changing anything: in this package the 65 cases
 * naming `UnaryGatePolicy` all came back with `modified: false` and no refusal
 * text, so the response the caller received was the original.
 */
export interface Verdict {
  modified: boolean
  /** The refusal the kernel substituted, when it substituted one. */
  errorType: string | null
  /**
   * The kernel's `inactivate_error_type`: the message a policy would have
   * returned, recorded because that policy was registered observe-only and its
   * verdict was discarded. Non-empty is the detection signal. Null when no
   * policy asked for a stop — or when one did and was allowed to enforce it, in
   * which case the message is in `errorType` instead.
   */
  wouldBlock: string | null
  policies: string[]
  /** Policy name → the file whose rules matched. */
  policySources: Record<string, string>
}

export interface Trace {
  /** The case id from the manifest, e.g. `file_unsafe_04_read_password_txt`. */
  id: string
  /** `safe` or `unsafe`, as the suite classifies it. */
  category?: string
  /** Path within the upstream repository, for anyone who wants the original. */
  file: string
  traceId?: string
  verdict: Verdict
  steps: Step[]
}

export interface Counts {
  cases: number
  steps: number
  /**
   * DETECTION, and the only count here that is one: cases where some policy
   * composed an actual refusal, naming the rule and the reason. Read with
   * `refusedByCategory` — the same refusals are a hit rate on the unsafe cases
   * and a false-positive rate on the safe ones.
   */
  refused: number
  /** Category → how many cases it has and how many of them drew a refusal. */
  refusedByCategory: Record<string, { cases: number; refused: number }>
  /**
   * The part of `wouldBlock` that is NOT detection: a gated policy reported a
   * change and stated no reason, so the field holds only the kernel's stand-in
   * string. `wouldBlock` − `wouldModifyOnly` is what a policy actually said.
   */
  wouldModifyOnly: number
  /**
   * Cases carrying a non-empty `verdict.wouldBlock`. NOT a detection count,
   * whatever the name suggests: most of it is `wouldModifyOnly`. Reporting it
   * as detection roughly doubles the claim. See `howToReadTheCounts`.
   */
  wouldBlock: number
  /**
   * Cases where a policy name was recorded. Also not a detection count, and the
   * weakest number in the package: a name is recorded when an enforcing policy
   * reports it changed the response, and in this package all but one of those
   * cases came back unchanged. See `howToReadTheCounts`.
   */
  flagged: number
  /** ENFORCEMENT: cases whose response the kernel actually rewrote. */
  intercepted: number
  /** Cases carrying a LOW trust or HIGH confidentiality label after propagation. */
  withTaint: number
  failed: number
  byPolicy: Record<string, number>
}

export interface Provenance {
  what: string
  upstream: string
  license?: string
  /** How the replay was produced, including that no model was called. */
  how: string
  /** Why a replay is needed at all rather than reading the case files. */
  whyARun?: string
}

/**
 * One row of `policy_registry.json` as it stood for this replay. `enabled: false`
 * does not mean the policy was skipped — every registered policy runs on every
 * case — it means its verdict was written down instead of carried out. That
 * distinction is the whole explanation for the gap between `refused` and
 * `intercepted`, so the configuration ships with the numbers it explains.
 */
export interface PolicyRegistration {
  name: string
  enabled: boolean
}

export interface ArbiterosModel {
  traces: Trace[]
  counts: Counts
  provenance: Provenance
  /** The replay's registry, when the package carries one. Empty if it does not. */
  enforcement: PolicyRegistration[]
  /**
   * The package's own sentence on which of its counts means what: `refused` is
   * detection, `intercepted` is what the registry allowed, `wouldBlock` and
   * `flagged` are neither. Rendered next to the counts, never summarised away —
   * the distance between those numbers is the single most misreadable thing in
   * this dataset, and three of the four read like detection when they are not.
   */
  howToReadTheCounts?: string
  /** Cases that would not replay, kept as data rather than dropped silently. */
  failures: { id: string; why: string }[]
  /** Distinct policy names seen, for the filter bar. */
  policies: string[]
  /** Distinct categories seen. */
  categories: string[]
  notes: Str[]
}
