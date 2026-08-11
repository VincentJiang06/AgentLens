/**
 * V3 — the counts, and the sentences without which they mislead.
 *
 * This is the screen the whole adapter can be wrong on. The replay produced
 * four numbers over the same 105 cases, and exactly one of them is a detection
 * count:
 *
 *   refused      — some policy composed an actual refusal, naming the rule and
 *                  the reason. This is DETECTION. 39.
 *   intercepted  — the response the caller received was not the one the model
 *                  produced. This is ENFORCEMENT, and a fact about the shipped
 *                  registry rather than about the policy set. 1.
 *   wouldBlock   — `inactivate_error_type` non-empty. 87 — but 49 of those hold
 *                  nothing except the stand-in string the kernel writes itself
 *                  when a gated policy reports a change and states no reason.
 *                  NOT detection, and it overstates by more than 2x.
 *   flagged      — a policy name was recorded. 66. NEITHER, and 65 of them are
 *                  UnaryGatePolicy re-serialising a tool call's arguments.
 *
 * `check_response_policy` runs all fifteen registered policies on every case;
 * `enabled` in `arbiteros_kernel/policy_registry.json` chooses whether a policy
 * enforces or observes, and it does not choose whether a policy runs.
 *
 * Three headlines are available on this data and all three are false. "1 of 105
 * intercepted" tells the group that wrote these cases that their suite stops one
 * attack. "66 detected" is a trap: a name is recorded when an ENFORCING policy
 * reports it changed the response, and 65 of those 66 came back with the model's
 * own response, unrewritten and with no refusal text. "87 detected" is the
 * subtler trap, and the one this panel shipped first — most of that field is a
 * sentence the kernel wrote, not a judgement a policy made. So:
 *
 *   - detection and enforcement are laid out as one pair inside one box, with
 *     one caption that reads them together. There is no arrangement of this
 *     component that renders one of them without the other;
 *   - the detection figure carries the suite's own safe/unsafe split, because
 *     the same 39 refusals are 21 of 45 attacks caught and 18 of 60 benign cases
 *     refused, and either number alone is the flattering half of one result;
 *   - `wouldBlock` and `flagged` are not in that box. They are further down,
 *     under their own heading, with the arithmetic that says what they were —
 *     and the per-policy table sits inside that section, because a table of
 *     policy names is a table about `flagged` and reading it as detection is the
 *     mistake;
 *   - the package's own `how_to_read_the_counts` is reproduced in full, as
 *     written, in the language it arrived in — it is data, like every other
 *     string the replay wrote, and paraphrasing it here is exactly the failure
 *     it exists to prevent. If a package arrives without it, the panel says that
 *     it did rather than quietly showing bare numbers;
 *   - the enforcement configuration is described, not judged. The words the
 *     kernel's own registry uses are `enabled: true` and `enabled: false`; the
 *     words here are "enabled" and "observe-only". No "only", no "fails to", no
 *     "should" — a reader is owed the configuration and their own conclusion.
 *
 * Every figure is printed over its denominator, and every denominator is this
 * package's own `traces`, recomputed here. Where that disagrees with the
 * `counts` block the package declared, the disagreement is shown; the package's
 * claim and the rows behind it are two different things and a viewer that
 * silently prefers one has stopped being a viewer.
 */

import { useMemo } from 'react'
import type { FC } from 'react'
import { useT } from '../../shell/lang'
import type { Str } from '../../shell/lang'
import { interceptedBy, taintedSteps } from './CaseBrowser'
import type { ArbiterosModel } from './contract'
import { WOULD_BLOCK_PLACEHOLDER, hasRefusal, wouldBlock as wasDetected, wouldBlockHasText } from './model'
import './browser.css'

/**
 * The enforcement configuration as a fallback only.
 *
 * `run.py` now ships `enforcement` — the replay's own `policy_registry.json`,
 * read from the checkout it ran against — so the panel prefers that and these
 * constants are used only for a package written before the field existed. That
 * ordering matters: a hard-coded registry is right until upstream flips a flag,
 * and then it is a screen full of confident wrong modes with nothing to catch
 * it. Where the fallback is what is on screen, the panel says so.
 *
 * `enabled: true` in that file at the time this was written: these four.
 */
const FALLBACK_ENABLED = [
  'RateLimitPolicy',
  'RelationalPolicy',
  'UnaryGatePolicy',
  'AlignmentSentinelPolicy',
]

/** `enabled: false`: the other eleven. They run; they do not rewrite. */
const FALLBACK_OBSERVE_ONLY = [
  'PathBudgetPolicy',
  'AllowDenyPolicy',
  'EfsmGatePolicy',
  'TaintPolicy',
  'OutputBudgetPolicy',
  'SecurityLabelPolicy',
  'ExecCompositePolicy',
  'DeletePolicy',
  'OpenClawPolicy',
  'NanobotPolicy',
  'ResourceGuardPolicy',
]

interface Registry {
  enabled: string[]
  observeOnly: string[]
  registered: number
  /** True when these lists came out of the package rather than the constants. */
  fromPackage: boolean
}

interface PolicyRow {
  name: string
  /** Cases where this policy reported a match. */
  matched: number
  /** Of those, cases whose response was rewritten. */
  rewritten: number
}

export const PolicyPanel: FC<{ model: ArbiterosModel }> = ({ model }) => {
  const t = useT()

  // The package's own registry when it ships one, this file's snapshot when it
  // does not. Never a merge of the two: a package written against a different
  // checkout is entitled to its own configuration, and filling its gaps from
  // here would put modes on screen that no run ever used.
  const registry: Registry = useMemo(() => {
    const shipped = model.enforcement
    if (shipped.length === 0) {
      return {
        enabled: FALLBACK_ENABLED,
        observeOnly: FALLBACK_OBSERVE_ONLY,
        registered: FALLBACK_ENABLED.length + FALLBACK_OBSERVE_ONLY.length,
        fromPackage: false,
      }
    }
    return {
      enabled: shipped.filter((one) => one.enabled).map((one) => one.name),
      observeOnly: shipped.filter((one) => !one.enabled).map((one) => one.name),
      registered: shipped.length,
      fromPackage: true,
    }
  }, [model.enforcement])

  const measured = useMemo(() => {
    let steps = 0
    let flagged = 0
    let intercepted = 0
    let refused = 0
    let refusedAndEnforced = 0
    let wouldBlockCount = 0
    let wouldModifyOnly = 0
    let namedUnchanged = 0
    let lowTrust = 0
    let highConf = 0
    let withTaint = 0
    const byCategory = new Map<string, { name: string; cases: number; refused: number }>()
    const rows = new Map<string, PolicyRow>()
    for (const trace of model.traces) {
      steps += trace.steps.length
      const rewritten = interceptedBy(trace)
      const refusal = hasRefusal(trace)
      if (trace.verdict.policies.length > 0) flagged += 1
      if (rewritten) intercepted += 1
      if (refusal) refused += 1
      if (refusal && rewritten) refusedAndEnforced += 1
      if (wasDetected(trace)) {
        wouldBlockCount += 1
        if (!wouldBlockHasText(trace)) wouldModifyOnly += 1
      }
      const category = trace.category ?? ''
      const bucket = byCategory.get(category) ?? { name: category, cases: 0, refused: 0 }
      bucket.cases += 1
      if (refusal) bucket.refused += 1
      byCategory.set(category, bucket)
      if (trace.verdict.policies.length > 0 && !rewritten) namedUnchanged += 1
      if (taintedSteps(trace) > 0) withTaint += 1
      if (trace.steps.some((one) => one.taint.propTrust === 'LOW')) lowTrust += 1
      if (trace.steps.some((one) => one.taint.propConf === 'HIGH')) highConf += 1
      for (const name of trace.verdict.policies) {
        const row = rows.get(name) ?? { name, matched: 0, rewritten: 0 }
        row.matched += 1
        if (rewritten) row.rewritten += 1
        rows.set(name, row)
      }
    }
    // A policy the package names but no case tripped belongs in the table at
    // zero: "did not match here" and "was not looked at" are different claims.
    for (const name of model.policies) {
      if (!rows.has(name)) rows.set(name, { name, matched: 0, rewritten: 0 })
    }
    return {
      cases: model.traces.length,
      steps,
      flagged,
      intercepted,
      refused,
      refusedAndEnforced,
      wouldBlockCount,
      wouldModifyOnly,
      // Unsafe first — the hit rate — then safe, its cost, then anything else.
      categories: [...byCategory.values()].sort(
        (a, b) =>
          (a.name === 'unsafe' ? 0 : a.name === 'safe' ? 1 : 2) -
            (b.name === 'unsafe' ? 0 : b.name === 'safe' ? 1 : 2) || a.name.localeCompare(b.name),
      ),
      namedUnchanged,
      withTaint,
      lowTrust,
      highConf,
      rows: [...rows.values()].sort((a, b) => b.matched - a.matched || a.name.localeCompare(b.name)),
    }
  }, [model.traces, model.policies])

  const declared = model.counts
  // The package's own figures against the rows it shipped. Equal on every
  // package the runner writes; shown when they are not. The field names are the
  // package's own keys, so a reader can go and look at the one that disagrees.
  const drift = useMemo(() => {
    const pairs: [string, number, number][] = [
      ['cases', declared.cases, measured.cases],
      ['steps', declared.steps, measured.steps],
      ['refused', declared.refused, measured.refused],
      ['wouldModifyOnly', declared.wouldModifyOnly, measured.wouldModifyOnly],
      ['wouldBlock', declared.wouldBlock, measured.wouldBlockCount],
      ['flagged', declared.flagged, measured.flagged],
      ['intercepted', declared.intercepted, measured.intercepted],
      ['withTaint', declared.withTaint, measured.withTaint],
      ['failed', declared.failed, model.failures.length],
    ]
    return pairs.filter(([, stated, found]) => stated !== found)
  }, [declared, measured, model.failures])

  const cases = measured.cases
  const clean = cases - measured.flagged
  // Which policy the `flagged` count is mostly made of, counted rather than
  // remembered. What those matches ARE is not this file's claim to make: the
  // package's own sentence, quoted verbatim above, is what says so.
  const leader = measured.rows[0]
  const leaderClause =
    leader === undefined || leader.matched === 0
      ? ''
      : ` — ${leader.matched} of the ${measured.flagged} are ${leader.name}, and the package's own note above says what those matches are`
  const leaderClauseZh =
    leader === undefined || leader.matched === 0
      ? ''
      : `——这 ${measured.flagged} 个里有 ${leader.matched} 个来自 ${leader.name}，上面数据包原文的说明里写了这些命中到底是什么`
  // The cases that did not replay are the ones this package can say least
  // about, so the denominator of everything above is stated against the
  // manifest it was drawn from rather than against itself.
  const failed = model.failures.length
  const attempted = cases + failed

  return (
    <section className="ab-pol stack">
      {/* The pair. One box, one caption, both numbers over the same
          denominator — there is no state of this component in which one of
          them is on screen without the other. */}
      <div className="ab-pair">
        <h3 className="ab-pair-title">
          {t({
            en: `What the kernel recorded over ${cases} cases and ${measured.steps} steps`,
            zh: `内核在 ${cases} 个 case、${measured.steps} 个步骤上记录到的结果`,
          })}
        </h3>
        <div className="ab-pair-figures">
          <div className="ab-figure">
            <b className="ab-figure-n">
              {measured.refused} <span className="ab-figure-d">/ {cases}</span>
            </b>
            <span className="ab-figure-label">
              {t({
                en: 'refused — a policy composed an actual refusal, naming the rule it applied and the reason',
                zh: '被拒绝——有 policy 真的写出了一条拒绝，说明了适用哪条规则、为什么',
              })}
            </span>
          </div>
          <div className="ab-figure">
            <b className="ab-figure-n">
              {measured.intercepted} <span className="ab-figure-d">/ {cases}</span>
            </b>
            <span className="ab-figure-label">
              {t({
                en: 'stopped — the response the caller received was not the one the model produced',
                zh: '被真正拦下——调用方收到的响应不是模型原本产出的那一条',
              })}
            </span>
          </div>
        </div>
        <p className="ab-pair-caption">
          {t({
            en:
              `Deciding and enforcing are different events, and the distance between them is the configuration. ` +
              `All ${registry.registered} registered policies run on every case; \`enabled\` in policy_registry.json decides ` +
              `whether a policy's verdict is carried out or written down, and ${registry.observeOnly.length} of the ` +
              `${registry.registered} are observe-only in the shipped default. ${measured.refusedAndEnforced} of the ` +
              `${measured.refused} refusals were carried out${
                measured.intercepted > measured.refusedAndEnforced
                  ? `, and ${measured.intercepted - measured.refusedAndEnforced} more responses were rewritten with no refusal recorded at all`
                  : ''
              }. Neither figure is a summary of the other.`,
            zh:
              `"判定"和"执行"是两件不同的事，它们之间的差距来自配置。全部 ${registry.registered} 条已注册 policy 在每个 case 上都会运行；` +
              `policy_registry.json 里的 \`enabled\` 决定一条 policy 的判定是被执行还是被记录下来，默认配置里 ${registry.registered} 条中有 ` +
              `${registry.observeOnly.length} 条是"仅观察"。这 ${measured.refused} 条拒绝里，真正被执行的是 ${measured.refusedAndEnforced} 条` +
              `${
                measured.intercepted > measured.refusedAndEnforced
                  ? `，另有 ${measured.intercepted - measured.refusedAndEnforced} 条响应被改写、却没有留下任何拒绝理由`
                  : ''
              }。任何一个数字都不是另一个的概括。`,
          })}
        </p>
        {/* The split, at the caption's weight rather than faint. A hit rate
            without its false-positive rate is the flattering half of one
            result, and this suite ships the labels that make both computable —
            so not showing both would be a choice. */}
        {measured.categories.length > 1 && (
          <p className="ab-pair-caption">
            {t({
              en:
                `The suite labels every case, so the same ${measured.refused} refusals are two rates: ` +
                measured.categories
                  .map(
                    (one) =>
                      `${one.refused} of the ${one.cases} it labels ${one.name === '' ? 'uncategorised' : one.name} (${Math.round((one.refused / one.cases) * 100)}%)`,
                  )
                  .join(', ') +
                '. Under enforcement these are what the shipped policy set would catch and what it would refuse by mistake.',
              zh:
                `套件给每个 case 都打了标签，所以同样这 ${measured.refused} 条拒绝其实是两个比率：` +
                measured.categories
                  .map(
                    (one) =>
                      `标为 ${one.name === '' ? '未分类' : one.name} 的 ${one.cases} 个里有 ${one.refused} 个（${Math.round((one.refused / one.cases) * 100)}%）`,
                  )
                  .join('，') +
                '。若切到强制执行模式，这两个数就分别是这套策略集会拦下的和会误伤的。',
            })}
          </p>
        )}
        {/* The number this panel used to headline, kept and demoted. Someone who
            has read `inactivate_error_type` elsewhere will come looking for 87
            and is owed an explanation of where it went, rather than its silent
            disappearance. */}
        <p className="ab-pair-caption">
          {t({
            en:
              `A larger number is available and is not the one above: ${measured.wouldBlockCount} of ${cases} cases ` +
              `have a non-empty \`inactivate_error_type\`. ${measured.wouldModifyOnly} of those hold nothing but the ` +
              `kernel's own stand-in line, “${WOULD_BLOCK_PLACEHOLDER}”, which it writes when a gated policy reports a ` +
              `change and states no reason. Those cases record that something would have happened, not that anything ` +
              `was judged. Neither kind says which policy: a gated policy is neutralised before the kernel takes its ` +
              `name down.`,
            zh:
              `还有一个更大的数字，但它不是上面那个：${cases} 个 case 里有 ${measured.wouldBlockCount} 个的 ` +
              `\`inactivate_error_type\` 非空。其中 ${measured.wouldModifyOnly} 个装的只是内核自己补的占位句` +
              `“${WOULD_BLOCK_PLACEHOLDER}”——那是"有 policy 报告说它会改动、但没说理由"时内核填进去的。` +
              `这些 case 记录的是"本来会发生点什么"，不是"有谁做出了判定"。两类都没记录是哪条 policy：` +
              `内核在记下名字之前，就把被限制的 policy 结果作废了。`,
          })}
        </p>
      </div>

      {/* The package's own words, reproduced. Not translated, not summarised:
          it came out of the replay, like the case ids and the tool-call JSON,
          and this is the one sentence in the dataset whose paraphrase is the
          documented failure mode. */}
      <div className="ab-quote">
        <p className="ab-quote-label faint">
          {t({
            en: 'The package’s own note on which of its counts means what, reproduced as written:',
            zh: '数据包自带的说明（哪个计数代表什么），原文照录：',
          })}
        </p>
        {model.howToReadTheCounts ? (
          <blockquote className="ab-quote-body">{model.howToReadTheCounts}</blockquote>
        ) : (
          <p className="notice warn">
            {t({
              en: 'This package carries no how_to_read_the_counts note. Detection and enforcement above are the pair; read the configuration below before either of them, and read the policy-name count further down as neither.',
              zh: '这个数据包没有带 how_to_read_the_counts 说明。上面的"检出"与"执行"必须成对读；在读它们之前先看下面的配置，而再往下的 policy 命中数两者都不是。',
            })}
          </p>
        )}
      </div>

      {/* The configuration, described. The registry's own vocabulary, this
          file's arithmetic, and no verdict on either. */}
      <div className="ab-config">
        <h4 className="ab-h">
          {t({ en: 'The shipped enforcement configuration', zh: '默认的执行配置' })}
        </h4>
        <p>
          {t({
            en:
              `check_response_policy runs all ${registry.registered} registered policies on every case. ` +
              `enabled in policy_registry.json chooses whether a policy enforces or observes; it ` +
              `does not choose whether it runs. ${registry.enabled.length} of the ${registry.registered} are enabled ` +
              `in the shipped default, and ${registry.observeOnly.length} of the ${registry.registered} observe. ` +
              `An observe-only policy's result is put back before the kernel records a name, which is why ` +
              `those ${registry.observeOnly.length} appear in no table of names on this page while their ` +
              `verdicts are still what most of the refusals above are made of.`,
            zh:
              `check_response_policy 会在每个 case 上运行全部 ${registry.registered} 条已注册 policy。` +
              `policy_registry.json 里的 enabled 决定一条 policy 是执行还是仅观察，而不决定它是否运行。` +
              `默认配置里 ${registry.registered} 条中有 ${registry.enabled.length} 条为启用、${registry.observeOnly.length} 条为仅观察。` +
              `"仅观察"的 policy，其结果会在内核记下名字之前被还原——这就是为什么这 ${registry.observeOnly.length} 条` +
              `不会出现在本页任何一张按名字统计的表里，而上面那些拒绝里的大部分，恰恰是它们判出来的。`,
          })}
        </p>
        <dl className="ab-modes">
          <dt>
            {t({
              en: `enabled — ${registry.enabled.length} of ${registry.registered}`,
              zh: `启用 —— ${registry.registered} 条中的 ${registry.enabled.length} 条`,
            })}
          </dt>
          <dd>
            {registry.enabled.map((name) => (
              <code key={name} className="ab-chip">
                {name}
              </code>
            ))}
          </dd>
          <dt>
            {t({
              en: `observe-only — ${registry.observeOnly.length} of ${registry.registered}`,
              zh: `仅观察 —— ${registry.registered} 条中的 ${registry.observeOnly.length} 条`,
            })}
          </dt>
          <dd>
            {registry.observeOnly.map((name) => (
              <code key={name} className="ab-chip">
                {name}
              </code>
            ))}
          </dd>
        </dl>
        <p className="faint">
          {t({
            en: registry.fromPackage
              ? 'These two lists come from the package itself: run.py records arbiteros_kernel/policy_registry.json as it stood for the replay, so the modes shown are the modes that produced the counts above.'
              : 'This package carries no registry, so these two lists are this viewer’s own snapshot of arbiteros_kernel/policy_registry.json, taken from one checkout. They are the one thing on this screen that is not in the package, and a replay run against a different configuration would not match them.',
            zh: registry.fromPackage
              ? '这两份名单来自数据包本身：run.py 把本次回放当时的 arbiteros_kernel/policy_registry.json 一并记了下来，所以这里显示的模式，就是产生上面那些计数的模式。'
              : '这个数据包没有带 registry，所以这两份名单是本查看器自己的快照，取自某一次的 arbiteros_kernel/policy_registry.json。它们是本屏上唯一不来自数据包的内容；如果这次回放用的是另一套配置，它们就对不上。',
          })}
        </p>
      </div>

      {/* The third number, kept and labelled. It is in the package, so hiding it
          would be its own kind of edit; it is down here, under a heading that
          says what it is not, because it is the figure a reader will otherwise
          walk away with. The arithmetic — how many of these cases came back
          unchanged — is what makes the label checkable rather than asserted. */}
      <div className="ab-config">
        <h4 className="ab-h">
          {t({
            en: 'An aside: cases with a policy name recorded (`flagged`) — not a detection count',
            zh: '附带一说：记录到 policy 名字的 case（`flagged`）——这不是检出数',
          })}
        </h4>
        <p>
          {t({
            en:
              `${measured.flagged} of ${cases} cases have a policy name recorded, and ` +
              `${measured.namedUnchanged} of those ${measured.flagged} came back with the response the model ` +
              `produced — not rewritten, no refusal text. A name is recorded when a policy registered to enforce ` +
              `reports that it changed the response${leaderClause}. Reporting a change is not the same as the ` +
              `caller receiving a different one, and this number is neither of the two above.`,
            zh:
              `${cases} 个 case 里有 ${measured.flagged} 个记录到了 policy 名字，其中 ${measured.namedUnchanged} 个` +
              `最终返回的仍是模型原本的响应——没有被改写，也没有拒绝文案。记录名字的条件是：一条被注册为"强制执行"的 policy ` +
              `报告自己改动了响应${leaderClauseZh}。"报告改过"和"调用方收到的东西变了"不是一回事，这个数字也不是上面两个中的任何一个。`,
          })}
        </p>
      </div>

      {/* Two columns, because one would let the reader supply the wrong second
          one from memory. This table belongs to the aside above it: every row
          is a policy NAME, and a name only exists for a policy the registry
          lets enforce. The detections have no rows here and the caption says
          so, rather than leaving a reader to read this as coverage. */}
      <div className="ab-table-wrap">
        <h4 className="ab-h">
          {t({
            en: `Which policies were named, over the same ${cases}-case suite`,
            zh: `被记录下来的是哪些 policy（同一批 ${cases} 个 case）`,
          })}
        </h4>
        <table className="ab-table">
          <thead>
            <tr>
              <th scope="col">{t({ en: 'Policy', zh: 'Policy' })}</th>
              <th scope="col">
                {t({ en: `Name recorded, of ${cases} cases`, zh: `记录到名字（共 ${cases} 个 case）` })}
              </th>
              <th scope="col">
                {t({ en: 'Response rewritten, of those', zh: '其中响应被改写' })}
              </th>
              <th scope="col">
                {t({ en: 'Mode in the shipped registry', zh: '在默认注册表中的模式' })}
              </th>
            </tr>
          </thead>
          <tbody>
            {measured.rows.map((row) => (
              <tr key={row.name}>
                <th scope="row" className="mono">
                  {row.name}
                </th>
                <td>
                  <span className="ab-cell">
                    <span className="ab-cell-n">
                      {row.matched} <span className="faint">/ {cases}</span>
                    </span>
                    <span className="ab-bar" aria-hidden="true">
                      <span style={{ width: `${(row.matched / Math.max(cases, 1)) * 100}%` }} />
                    </span>
                  </span>
                </td>
                <td>
                  {row.matched === 0
                    ? t({ en: 'no case to count', zh: '没有可计的 case' })
                    : t({
                        en: `${row.rewritten} of ${row.matched}`,
                        zh: `${row.matched} 个中的 ${row.rewritten} 个`,
                      })}
                </td>
                <td className="faint">{t(modeOf(row.name, registry))}</td>
              </tr>
            ))}
            <tr>
              <th scope="row" className="ab-rest">
                {t({ en: 'No policy name recorded', zh: '没有记录到 policy 名字' })}
              </th>
              <td>
                <span className="ab-cell">
                  <span className="ab-cell-n">
                    {clean} <span className="faint">/ {cases}</span>
                  </span>
                  <span className="ab-bar" aria-hidden="true">
                    <span style={{ width: `${(clean / Math.max(cases, 1)) * 100}%` }} />
                  </span>
                </span>
              </td>
              <td>—</td>
              <td className="faint">—</td>
            </tr>
          </tbody>
        </table>
        <p className="faint">
          {t({
            en: 'A name in this table means that policy reported it had changed the response on that many cases. Whether the caller then received a different response is the third column. Only policies registered to enforce can appear here at all, so this table is silent about the detections above, and a case can appear in more than one row.',
            zh: '表中出现一个名字，意思是这条 policy 在那么多 case 上报告了"自己改动了响应"；调用方最终是否收到了不同的响应，是第三列的事。只有被注册为强制执行的 policy 才可能出现在这里，所以这张表对上面的检出数只字未提；同一个 case 可以出现在多行里。',
          })}
        </p>
      </div>

      {/* Taint gets its definition printed with it: "9 cases carry taint" is
          not a fact until the reader knows which label at which end of which
          chain is being counted. */}
      <div className="ab-config">
        <h4 className="ab-h">{t({ en: 'Taint after propagation', zh: '传播之后的污点' })}</h4>
        <p>
          {t({
            en:
              `${measured.withTaint} of ${cases} cases have at least one step carrying LOW trust or ` +
              `HIGH confidentiality after propagation: ${measured.lowTrust} of ${cases} carry LOW ` +
              `trust and ${measured.highConf} of ${cases} carry HIGH confidentiality.`,
            zh:
              `${cases} 个 case 中有 ${measured.withTaint} 个，在传播之后至少有一步带 LOW 可信度或 HIGH 机密度：` +
              `其中 ${measured.lowTrust} 个带 LOW 可信度，${measured.highConf} 个带 HIGH 机密度。`,
          })}
        </p>
        <p className="faint">
          {t({
            en: 'Trust takes the minimum along the reference chain and confidentiality the maximum, so a step’s propagated label is its own label combined with everything it referenced. Where the two differ, some ancestor moved it, and the graph is where that ancestor is named.',
            zh: '可信度沿引用链取最小值、机密度取最大值，所以一个步骤传播后的标签，是它自身的标签与它引用过的一切合并而来。两者不一致时，是某个上游步骤造成的——具体是哪一个，由图来指认。',
          })}
        </p>
      </div>

      {/* What the denominator itself rests on. A suite where a fifth of the
          cases would not replay is a different suite, so the figure is stated
          whether or not it is zero. */}
      <p className="ab-coverage faint">
        {t({
          en: `${cases} of ${attempted} cases in the manifest replayed; ${failed} did not.`,
          zh: `manifest 中的 ${attempted} 个 case 里，${cases} 个完成回放，${failed} 个没有。`,
        })}
      </p>
      {failed > 0 && (
        <ul className="ab-failures">
          {model.failures.map((one) => (
            <li key={one.id}>
              <code className="mono">{one.id}</code> <span className="faint">{one.why}</span>
            </li>
          ))}
        </ul>
      )}

      {drift.length > 0 && (
        <div className="ab-drift">
          <p className="notice warn">
            {t({
              en: 'The counts this package declares differ from the traces it ships. Both are shown; every figure above is recomputed from the traces.',
              zh: '这个数据包声明的计数与它自带的 trace 对不上。两者都列出；上面每个数字都是从 trace 重算的。',
            })}
          </p>
          <ul className="ab-failures">
            {drift.map(([field, stated, found]) => (
              <li key={field}>
                <code className="mono">{field}</code>{' '}
                {t({
                  en: `declared ${stated}, counted ${found} in the traces`,
                  zh: `声明为 ${stated}，在 trace 中数到 ${found}`,
                })}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Collapsed, because it is the same on every reload — but present, because
          "no model was called" is why these are the kernel's verdicts and not an
          LLM's opinion of them. */}
      <details className="ab-details">
        <summary>
          {t({ en: 'Where these numbers come from', zh: '这些数字是怎么来的' })}
        </summary>
        <dl className="kv">
          <dt>{t({ en: 'Data', zh: '数据' })}</dt>
          <dd>{model.provenance.what}</dd>
          <dt>{t({ en: 'Upstream', zh: '上游' })}</dt>
          <dd>{model.provenance.upstream}</dd>
          {model.provenance.license !== undefined && (
            <>
              <dt>{t({ en: 'License', zh: '许可' })}</dt>
              <dd>{model.provenance.license}</dd>
            </>
          )}
          <dt>{t({ en: 'How', zh: '如何产生' })}</dt>
          <dd>{model.provenance.how}</dd>
          {model.provenance.whyARun !== undefined && (
            <>
              <dt>{t({ en: 'Why a replay', zh: '为什么要跑一遍' })}</dt>
              <dd>{model.provenance.whyARun}</dd>
            </>
          )}
        </dl>
      </details>
    </section>
  )
}

/* ----------------------------------------------------------------- pure-ish */

/**
 * How the registry in force has this policy set. A name in neither list gets
 * neither label: when the package ships no registry the snapshot below is from
 * one checkout, and a package replayed against a different one may carry
 * policies it has never heard of.
 */
function modeOf(name: string, registry: Registry): Str {
  if (registry.enabled.includes(name)) return { en: 'enabled', zh: '启用' }
  if (registry.observeOnly.includes(name)) return { en: 'observe-only', zh: '仅观察' }
  return { en: 'not in the registry read here', zh: '不在此处读到的注册表内' }
}
