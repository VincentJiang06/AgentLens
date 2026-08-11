# PromptWise runner

**English** · [中文](#中文)

`run.py` drives [PromptWise](https://github.com/yannxiaoyanhu/PromptWise)'s own learners over
its own synthetic setup and writes down what they decided, step by step. Its output is the
`promptwise@1` package the AgentLens `promptwise` adapter renders.

| Script | Writes | Needs |
| --- | --- | --- |
| `run.py` | a `promptwise@1` JSON package, wherever `--out` says | a checkout of [yannxiaoyanhu/PromptWise](https://github.com/yannxiaoyanhu/PromptWise), Python 3, NumPy, and the SciPy and scikit-learn its learners import |

Nothing in `npm run build`, `npm run dev` or the deployed site runs this. The output is
committed; the script is here so the run can be argued with instead of taken on trust.

> **The data is synthetic.** Random 768-dimensional embeddings stand in for prompts, and a
> table of coin flips stands in for whether a model can solve one. No number this script
> produces is any model's real accuracy, none of it reproduces a figure from the paper, and
> `MODEL_A`…`MODEL_E` are not real models — they are upstream's own placeholder names, kept
> verbatim. What the run shows is *algorithm behaviour*: which arm a cost-aware router picks,
> when it gives up on it, and what that costs.

---

## Why it exists

The upstream repository open-sources the algorithms and not the experiment pipeline. Two
consequences, both of which this script is a response to:

- **The curves are never saved.** `utils/aux.py:123` defines `save_stats`, which would write
  the cost, success, utility, OPR and oracle arrays to an `.npz`. Nothing in the repository
  calls it — `grep -rn save_stats` returns that one line — and there is no plotting code. So
  the numbers exist only inside a line `test.py` prints every hundred steps.
- **The decisions are never saved at all.** Which model was tried, what it cost, whether it
  worked, and what the router believed about the other four at that moment are held in
  instance attributes that the next round overwrites. `promptwise.rd_ucb_q` (the optimistic
  success estimate it acted on) and `rd_ucb_u` (the utility it maximised) are the only record
  of *why* this arm and not another, and they are gone a few microseconds later.

`run.py` writes both, reading those two attributes in the window where they exist. It imports
`algorithms.aux.LEARNER` and `utils.aux.cost_aware_env` from a checkout you supply and calls
them exactly as `test.py` does — one deliberate exception, [below](#the-one-departure-from-testpy).
No upstream file is copied into this repository and none is modified by the run.

## Usage

```sh
python scripts/promptwise-runner/run.py \
    --promptwise /path/to/PromptWise \
    --out public/demo-data/promptwise/uniform.json
```

`--promptwise` is the checkout's root — the directory holding `algorithms/` and `utils/`. The
script checks for `algorithms/aux.py` and exits with the reason if it is not there, rather than
failing later inside an import.

The two packages this repository ships were produced by these two runs, in this order, with
`--promptwise` pointing at a checkout on the branch described below:

```sh
python scripts/promptwise-runner/run.py --promptwise ../PromptWise \
    --out public/demo-data/promptwise/uniform.json --steps 1000 --epochs 20

python scripts/promptwise-runner/run.py --promptwise ../PromptWise \
    --out public/demo-data/promptwise/tiered.json  --steps 1000 --epochs 20 \
    --tiers 0.88 0.32 0.82 0.50 0.56
```

Each is eight learners × 20 epochs × 1,000 steps: on the laptop these were built on, 14
minutes for the first and 24 for the second, which is not noise — a world where models differ
makes more calls per prompt, and more calls is more work. The run prints each learner's final
figures as it finishes it. Rebuild both if you rebuild either; the point of the pair is the
comparison between them.

### What the checkout needs

The upstream code predates NumPy 1.25 and two of the eight learners raise under it:

| File | What breaks | The fix |
| --- | --- | --- |
| `algorithms/promptwise.py` | `predict()` returns a size-1 array, and NumPy ≥ 1.25 refuses to assign one into a scalar slot (`rd_ucb_q[g] = …`) | collapse it with `float(np.squeeze(…))` |
| `algorithms/ca_pak_ucb_tS.py` | if forced exploration ends mid-step, `rd_ucb_values` is still `None` on the next round and `np.where(None == …)` raises | recompute when it `is None` rather than when `rd_used_budget == 0` |

Both are three-line changes and neither touches what the algorithms do; the second also
removes a silent wrong answer, since before NumPy 1.25 that comparison did not raise, it
quietly selected arm 0. They live on a local `fix/numpy2-compat` branch of the checkout used
here and **are not upstream** — a fresh clone of `main` does not have them, and `--learners
promptwise` and `--learners ca-pak-ucb-tS` will raise on it. Either apply the two changes
yourself or pin NumPy < 1.25. The six baseline learners were not touched.

The packages here were built under CPython 3.14.6 with NumPy 2.5.2, SciPy 1.18.0 and
scikit-learn 1.9.0. The last two are the upstream learner's imports — `scipy.optimize.minimize`
and `sklearn.metrics.pairwise.rbf_kernel`, both at the top of `algorithms/promptwise.py` — and
not this script's; `run.py` imports nothing but the standard library and NumPy.

## The one departure from `test.py`

`test.py` draws the prompt for step *t* inside the loop:

```python
id_t = np.random.randint(n_data)
```

from the same global NumPy RNG the learners and the environment draw from. Learners consume
randomness at different rates — a *till-succeed* learner may make five calls in a step where
`greedy` makes one, and every call draws its own outcome — so after a handful of steps the RNG
state has diverged and **each learner is answering a different sequence of prompts.** Compared
learner-to-learner, the curves are then not over the same tasks.

`run.py` draws the whole prompt stream up front, before any learner exists, and replays that
one stream through every learner:

```python
prompt_stream = np.random.randint(args.n_data, size=(args.epochs, args.steps))
```

That is the only change, and it is what makes the comparison a comparison. It is a
methodological point about a research script, not a criticism of the algorithms: `test.py` is
a demonstration that one learner runs, and for that purpose the shared stream buys nothing.

Two things it does **not** do, stated so the claim is not read as stronger than it is. The
per-call outcome is still drawn at call time from the global RNG, exactly as upstream draws
it, so two learners that reach the same prompt do not necessarily see the same coin land the
same way; what they share is the world (one success table, one prompt order), not each
individual flip. And each epoch reseeds with `seed + epoch` before the learner is built, so a
learner's own tie-breaking is reproducible run to run without being able to shift the stream.

## What comes out

One JSON object, `"agentlens_format": "promptwise@1"`, which is what routes it to the
`promptwise` adapter — the shell matches the name before the `@` against a registered
adapter's own name.

```jsonc
{
  "agentlens_format": "promptwise@1",
  "source":   { "what", "upstream", "branch", "data", "note", "departure" },
  "config":   { "models": [{ "name", "cost" }], "steps", "epochs", "seed",
                "cost_para", "rd_budget", "tau_exp", "reg_method", "kernel_method",
                "n_data", "dim", "success_rates" },
  "trace_sampling": { "epoch", "rule" },
  "runs": [
    {
      "learner": "promptwise",
      "curves":  { "t": [...], "utility": [...], "cost": [...], "success": [...], "opr": [...] },
      "visitation": { "MODEL_A": 0.00097, ... },
      "final":   { "utility", "cost", "success", "opr" },
      "oracle_utility": 0.92164,
      "steps": [
        { "t": 176, "prompt_id": 141, "outcome": "success", "escalated": true,
          "rounds": [ { "arm": "MODEL_B", "cost": 0.75, "reward": 0,
                        "beliefs": { "ucb_q": [...], "utility": [...] } }, ... ] }
      ]
    }
  ]
}
```

`source.data` is the synthetic warning in the runner's own words, and it is written per
package: the two packages describe their success tables differently because they have
different ones. The adapter renders that string rather than composing its own.

### The curves are upstream's, including their normalisation

Every array under `curves` is one of `save_stats`'s, divided the way `save_stats` divides it —
by `arange(1, T+1) * epochs`, because the environment accumulates across both steps and
epochs. They are cumulative means per step, not per-step values:

| Field | Upstream name | What one point means |
| --- | --- | --- |
| `utility` | `alg_v` | mean over steps so far of `(1 if the prompt was solved else 0) − cost_para × what the step spent` |
| `cost` | `total_cost` | mean spend per step, in the price units of `MODEL_COST` |
| `success` | `cumulative_reward` | share of steps that ended solved (a step stops at the first success, so this is at most 1) |
| `opr` | `opr` | of the calls made, the share that went to an arm an oracle would have picked |
| `oracle_utility` | `ref_v` | the ceiling on the same stream: `max_g (1 − cost_para · cost_g / pass@1_g)`. Not a competitor — no learner knows `pass@1` |

`visitation` is upstream's `pick_ratio`, which is a step's own share of calls averaged over
steps — not the share of all calls in the run. A step that makes one call to `MODEL_B`
contributes as much to `MODEL_B` as a step that makes five.

### The trace is sampled, and says so

Writing all 1,000 steps for all eight learners produces a file too big to open comfortably, so
`steps` is a sample of **epoch 0 only** while the curves are over all 20 epochs. The rule is
in the package under `trace_sampling` and is: every step below `--keep-first` (50), then every
`--sample-every`th (20th), **plus every escalation, always**. Escalations are the behaviour a
viewer of this data exists to look at; sampling them away would shrink nothing but the file.

A step is marked `"escalated": true` on one rule, and the rule is worth stating because every
escalation count below is a count of exactly this: the step made more than one call, and its
**last** call was dearer than its **first**. Because the sampler keeps all of them, a count of
them in the trace is the complete count for that epoch — the one number in the sampled block
that is not itself a sample. It is a floor on "went up in price and came back", not a census
of it: a step that tries cheap, tries dear, then returns to cheap is not marked.

## What the two packages show

This is the part worth reading twice, and it is the reason the repository ships two packages
instead of one.

**`uniform.json` is upstream's own world.** `test.py` builds its success table with

```python
model_result_array = np.random.randint(2, size=(G, n_data, 10))
```

— a fair coin for every (model, prompt) pair, so all five models solve about half of
everything, and the dearest is worth exactly as much as the cheapest. In that world there is
nothing to escalate *to*: the correct play is to call the cheapest model and, if it fails, call
it again. That is what the router does, measured over 20 epochs × 1,000 steps:

| learner | utility | cost / step | solved / step | where the calls went |
| --- | --- | --- | --- | --- |
| `promptwise` | **0.86339** | 1.528 | 0.9398 | 98.0% `MODEL_B`, the cheapest |
| `lowest-cost` | 0.47765 | 0.750 | 0.5152 | 100% `MODEL_B`, one call, no retry |
| `highest-cost` | −0.13290 | 12.500 | 0.4921 | 100% `MODEL_A`, the dearest |
| oracle | 0.92164 | — | — | — |

1.528 per step at 0.75 a call is 2.04 calls, and 98% of them go to the cheapest model: the
router is retrying, not escalating. Its trace agrees — of epoch 0's 1,000 steps, **7** are
escalations, and since the sampler keeps every escalation that 7 is the whole count, not a
sample of one. Nearly doubling the spend to nearly double the solve rate is the right answer
here, and it is not the paper's mechanism.

**`tiered.json` gives the models different competences,** which is the only change: a per-model
success probability replaces the fair coin, so `--tiers 0.88 0.32 0.82 0.50 0.56` says
`MODEL_A` (12.50 a call) solves 88% and `MODEL_B` (0.75) solves 32%. Those five numbers are
**ours**, not the paper's, and the package says so in `config.success_rates` and in
`source.data`. With them, escalation appears immediately:

Every learner in the package, so the comparison is not built from the ones it beats:

| learner | utility | cost / step | solved / step | where the calls went |
| --- | --- | --- | --- | --- |
| `GtS` | **0.70377** | 5.157 | 0.9616 | greedy, then retry until solved |
| `promptwise` | **0.70214** | **2.208** | 0.8125 | 90.0% `MODEL_B`, then 9.2% `MODEL_D` |
| `RtS` | 0.56592 | 8.480 | 0.9899 | random, then retry until solved |
| `ca-pak-ucb-tS` | 0.51062 | 9.336 | 0.9774 | the paper's comparison bandit |
| `greedy` | 0.43015 | 3.115 | 0.5859 | one shot at the current best guess |
| `random` | 0.35194 | 5.165 | 0.6102 | one shot, uniformly |
| `lowest-cost` | 0.25800 | 0.750 | 0.2955 | 100% `MODEL_B` |
| `highest-cost` | 0.24865 | 12.500 | 0.8737 | 100% `MODEL_A` |
| oracle | 0.89043 | — | — | — |

**`GtS` ends 0.0016 above `promptwise` on utility, and spends 2.3× as much to do it.**
That is the row worth reading, and quoting the table without it would be quoting a
result that the first person to open the demo disproves by scrolling. Utility here is
`solved − 0.05 × cost`, so at this cost coefficient the two are a wash on the composite
and separate on the thing the paper is about: `promptwise` reaches 84% of `GtS`'s solve
rate for 43% of its spend. Which of those you want is a question about your budget, and
the Pareto view is there to let a reader answer it rather than be told.

Three more things to read off it. The router still opens on the cheapest model — it
should, at 0.75 against 12.50 — but now it moves on when that fails: `MODEL_D`'s share of
calls goes from 1.7% in the uniform world to 9.2% here, and epoch 0 holds **37**
escalations against the uniform package's 7, both complete counts over 1,000 steps. The
two fixed policies end 0.009 apart for opposite reasons — cheap and usually wrong, dear
and usually right, priced the same. And in `uniform.json`, where no model is worth
escalating to, `promptwise` is the outright maximum at 0.86339 against `GtS`'s 0.80098.

Neither package is the more honest one. Upstream's table is a perfectly reasonable smoke test
for "does the learner run", and the router's behaviour under it is correct rather than
degenerate — it is worth saying out loud that a cost-aware router in a world with no quality
gradient *should* collapse onto the cheapest arm. But a reader who only ever sees that world
never sees the thing the paper is about. Shipping both, side by side, is the honest version of
"here is what this algorithm does".

## Flags

`--promptwise` and `--out` are required; everything else defaults to `test.py`'s own defaults,
so a bare run reproduces its configuration.

| Flag | Default | What it is |
| --- | --- | --- |
| `--learners` | all eight | any of `promptwise`, `ca-pak-ucb-tS`, `greedy`, `GtS`, `random`, `RtS`, `lowest-cost`, `highest-cost` — upstream's `LEARNER` keys |
| `--steps` | 1000 | `T`, prompts per epoch |
| `--epochs` | 20 | independent repeats the curves average over |
| `--seed` | 1234 | seeds the shared world; each epoch then reseeds with `seed + epoch` |
| `--tiers A B C D E` | off | per-model success probability, in pool order. Omitted, the success table is upstream's uniform `randint(2, …)` |
| `--cost-para` | 0.05 | `cost_para`: how much a unit of spend is worth against a solve |
| `--rd-budget` | 5 | most calls one prompt may take before the router gives up |
| `--n-data`, `--dim` | 164, 768 | prompts in the pool, and embedding width |
| `--kernel-method`, `--reg-method`, `--tau-exp`, `--exp-para` | `rbf`, `klr`, 1, `None` | passed through to the learner untouched |
| `--keep-first`, `--sample-every` | 50, 20 | the trace sampling rule; escalations are kept regardless |

`MODEL_SET` and `MODEL_COST` are deliberately *not* flags. They are `test.py`'s five names and
five prices, hard-coded here as they are there, because changing them would make these curves
incomparable with anything the authors ran.

## Attribution

PromptWise is by Xiaoyan Hu, Lauren Pick, Ho-fung Leung and Farzan Farnia
([arXiv:2505.18901](https://arxiv.org/abs/2505.18901)), MIT-licensed. AgentLens vendors none of
it: this script imports from a checkout you supply, and the packages under
`public/demo-data/promptwise/` contain only numbers our own run produced. Full terms are in
[`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md).

---

## 中文

`run.py` 让 [PromptWise](https://github.com/yannxiaoyanhu/PromptWise) 自己的学习器在它自己的合成
设定上跑起来，并逐步记录它们的决策。输出是 `promptwise@1` 数据包，由 AgentLens 的 `promptwise`
适配器渲染。

| 脚本 | 写出什么 | 需要什么 |
| --- | --- | --- |
| `run.py` | 一个 `promptwise@1` JSON 包，路径由 `--out` 指定 | 一份 [yannxiaoyanhu/PromptWise](https://github.com/yannxiaoyanhu/PromptWise) 的 checkout、Python 3、NumPy，以及它的学习器要 import 的 SciPy 和 scikit-learn |

`npm run build`、`npm run dev` 和部署好的站点都不会运行这个脚本。输出是提交进仓库的；脚本放在这里，
是为了让这次运行可以被质疑，而不是被将就地信任。

> **数据是合成的。** 提示词由随机的 768 维向量代替，模型能不能解出一道题由一张抛硬币的表代替。
> 这个脚本产出的任何数字都不是任何模型的真实准确率，也没有一个数字复现了论文里的图，
> `MODEL_A`…`MODEL_E` 更不是真实模型——那是上游自己的占位名，原样保留。这次运行展示的是
> **算法行为**：一个成本感知的路由器会选哪个模型、什么时候放弃它、以及这要花多少钱。

---

### 为什么需要它

上游仓库开源了算法，但没有开源实验流程。由此有两个后果，这个脚本正是对它们的回应：

- **曲线从来没有被保存过。** `utils/aux.py:123` 定义了 `save_stats`，它本该把成本、成功率、效用、
  OPR 和 oracle 这几组数组写成 `.npz`。但仓库里没有任何地方调用它——`grep -rn save_stats` 只有
  那一行——也没有任何绘图代码。于是这些数字只存在于 `test.py` 每一百步打印的那一行里。
- **决策则根本没有被保存。** 试了哪个模型、花了多少、成没成功，以及在那一刻路由器对另外四个模型
  怎么想的，都存在会被下一轮覆盖的实例属性里。`promptwise.rd_ucb_q`（它据以行动的乐观成功率估计）
  和 `rd_ucb_u`（它最大化的那个效用）是"为什么是这个模型而不是另一个"的唯一记录，而它们几微秒后就
  没有了。

`run.py` 把两者都写下来，并在那两个属性还存在的窗口里读它们。它从你提供的 checkout 里 import
`algorithms.aux.LEARNER` 和 `utils.aux.cost_aware_env`，并且完全按 `test.py` 的方式调用它们——
只有一处有意的例外，见[下文](#与-testpy-唯一的一处不同)。没有任何上游文件被复制进本仓库，
运行过程也不修改上游的任何文件。

### 用法

```sh
python scripts/promptwise-runner/run.py \
    --promptwise /path/to/PromptWise \
    --out public/demo-data/promptwise/uniform.json
```

`--promptwise` 指向 checkout 的根目录——也就是装着 `algorithms/` 和 `utils/` 的那一层。脚本会检查
`algorithms/aux.py` 是否存在，不存在就带着原因退出，而不是等到后面 import 的时候才炸。

本仓库随包发布的两个数据包，是由下面这两次运行按顺序产出的，其中 `--promptwise` 指向的是一份处在
下文所述那个分支上的 checkout：

```sh
python scripts/promptwise-runner/run.py --promptwise ../PromptWise \
    --out public/demo-data/promptwise/uniform.json --steps 1000 --epochs 20

python scripts/promptwise-runner/run.py --promptwise ../PromptWise \
    --out public/demo-data/promptwise/tiered.json  --steps 1000 --epochs 20 \
    --tiers 0.88 0.32 0.82 0.50 0.56
```

每条都是 8 个学习器 × 20 个 epoch × 1,000 步：在构建这两个包的那台笔记本上，第一条花了 14 分钟，
第二条花了 24 分钟，这个差别不是噪声——模型之间有能力差的世界里，每条提示词要打的调用更多，
而调用更多就是活更多。每跑完一个学习器就会打印它的最终数字。要重建就两个一起重建，
这一对的意义正在于互相对照。

#### checkout 需要满足什么

上游代码早于 NumPy 1.25，八个学习器里有两个在它下面会抛错：

| 文件 | 坏在哪 | 怎么修 |
| --- | --- | --- |
| `algorithms/promptwise.py` | `predict()` 返回一个 size-1 数组，而 NumPy ≥ 1.25 不再允许把它赋给一个标量位置（`rd_ucb_q[g] = …`） | 用 `float(np.squeeze(…))` 收成标量 |
| `algorithms/ca_pak_ucb_tS.py` | 强制探索阶段若在某一步中间结束，下一轮 `rd_ucb_values` 仍是 `None`，`np.where(None == …)` 抛错 | 判断条件改成它 `is None`，而不是 `rd_used_budget == 0` |

两处都是三行的改动，都不改变算法做什么；第二处还顺带消掉了一个无声的错误答案——在 NumPy 1.25 之前
那次比较不会抛错，而是悄悄选中 0 号模型。它们位于这里所用 checkout 的本地分支 `fix/numpy2-compat`
上，**并不在上游**：新克隆的 `main` 没有这两处改动，在它上面 `--learners promptwise` 和
`--learners ca-pak-ucb-tS` 会抛错。要么自己把这两处改上去，要么把 NumPy 钉在 1.25 以下。
另外六个基线学习器没有动过。

这里的两个包是在 CPython 3.14.6 上、用 NumPy 2.5.2、SciPy 1.18.0 和 scikit-learn 1.9.0 构建的。
后两个是上游学习器自己的 import——`scipy.optimize.minimize` 和
`sklearn.metrics.pairwise.rbf_kernel`，都在 `algorithms/promptwise.py` 的开头——不是这个脚本的；
`run.py` 除了标准库和 NumPy 什么都不 import。

### 与 `test.py` 唯一的一处不同

`test.py` 在循环里抽取第 *t* 步的提示词：

```python
id_t = np.random.randint(n_data)
```

用的是学习器和环境共用的那个 NumPy 全局随机源。而不同学习器消耗随机数的速度不一样——一个
*till-succeed* 类的学习器可能在某一步打五次调用，而 `greedy` 只打一次，并且每一次调用又各自抽一次
结果——所以走不了几步，随机数状态就分岔了，**每个学习器面对的其实是一串不同的提示词。**
这样一来，拿来互相比较的那些曲线，算的并不是同一批任务。

`run.py` 在任何学习器存在之前，先把整条提示词序列一次抽好，再把这同一条序列在每个学习器上重放一遍：

```python
prompt_stream = np.random.randint(args.n_data, size=(args.epochs, args.steps))
```

这是唯一的改动，也正是它让这个对照成其为对照。这是关于一个研究脚本的方法学问题，不是对算法的批评：
`test.py` 是用来演示单个学习器能跑起来的，就那个目的而言，共享序列买不到任何东西。

有两件事它**没有**做，写在这里以免这个断言被读得比它本身更强。每一次调用的结果仍然是在调用发生时
从全局随机源里抽的，和上游抽的方式一模一样，所以两个学习器走到同一条提示词上，未必看到同一枚硬币
落成同一面；它们共享的是这个世界（同一张成功率表、同一个提示词顺序），而不是每一次抛掷。以及，
每个 epoch 在构造学习器之前用 `seed + epoch` 重新播种，因此学习器自己的打破平局是逐次可复现的，
同时又动不了那条提示词序列。

### 输出的是什么

一个 JSON 对象，`"agentlens_format": "promptwise@1"`，这正是把它路由给 `promptwise` 适配器的
东西——外壳拿 `@` 前面的名字去匹配已注册适配器自己的名字。

```jsonc
{
  "agentlens_format": "promptwise@1",
  "source":   { "what", "upstream", "branch", "data", "note", "departure" },
  "config":   { "models": [{ "name", "cost" }], "steps", "epochs", "seed",
                "cost_para", "rd_budget", "tau_exp", "reg_method", "kernel_method",
                "n_data", "dim", "success_rates" },
  "trace_sampling": { "epoch", "rule" },
  "runs": [
    {
      "learner": "promptwise",
      "curves":  { "t": [...], "utility": [...], "cost": [...], "success": [...], "opr": [...] },
      "visitation": { "MODEL_A": 0.00097, ... },
      "final":   { "utility", "cost", "success", "opr" },
      "oracle_utility": 0.92164,
      "steps": [
        { "t": 176, "prompt_id": 141, "outcome": "success", "escalated": true,
          "rounds": [ { "arm": "MODEL_B", "cost": 0.75, "reward": 0,
                        "beliefs": { "ucb_q": [...], "utility": [...] } }, ... ] }
      ]
    }
  ]
}
```

`source.data` 就是那段"数据是合成的"的声明，用运行脚本自己的措辞写成，并且是逐包写的：两个包对自己
那张成功率表的描述不一样，因为它们的表本来就不一样。适配器渲染的是这个字符串，而不是自己另编一句。

#### 曲线是上游的，连归一化方式也是

`curves` 下的每一组数组都来自 `save_stats`，并且按 `save_stats` 的除法来除——除以
`arange(1, T+1) * epochs`，因为环境是跨步、跨 epoch 一起累加的。它们是"到这一步为止的每步均值"，
不是每一步的取值：

| 字段 | 上游名字 | 一个点意味着什么 |
| --- | --- | --- |
| `utility` | `alg_v` | 到目前为止各步的均值：`(解出为 1，否则为 0) − cost_para × 这一步花掉的钱` |
| `cost` | `total_cost` | 每步平均花费，单位是 `MODEL_COST` 的价格单位 |
| `success` | `cumulative_reward` | 以"解出"收尾的步所占比例（一步在第一次成功时就结束，所以这个值至多为 1） |
| `opr` | `opr` | 在打出去的调用里，落在 oracle 会选的那个模型上的比例 |
| `oracle_utility` | `ref_v` | 同一条序列上的上限：`max_g (1 − cost_para · cost_g / pass@1_g)`。它不是竞争者——没有任何学习器知道 `pass@1` |

`visitation` 是上游的 `pick_ratio`，含义是"每一步内部的调用占比，再对步取平均"——不是整场运行里所有
调用的占比。一个只打了一次 `MODEL_B` 的步，和一个打了五次的步，对 `MODEL_B` 的贡献一样大。

#### 决策轨迹是抽样的，而且写明了这件事

把八个学习器的 1,000 步全写下来，文件会大到不好打开，所以 `steps` **只取 epoch 0**，而曲线是全部
20 个 epoch 上的。规则写在包里的 `trace_sampling` 下，内容是：`--keep-first`（50）以下的每一步、
之后每 `--sample-every`（20）步一取，**外加每一次升级调用，一次不落**。升级正是这份数据的查看器要
看的行为；把它们抽掉，缩小的只有文件本身。

一个步会被标成 `"escalated": true`，判据只有一条，而这条判据值得写出来，因为下文每一个升级计数数的
都恰好是它：这一步打了不止一次调用，并且**最后**一次比**第一**次贵。也正因为抽样规则把它们全留下
了，轨迹里数出来的升级次数就是那个 epoch 的完整次数——它是这个抽样块里唯一一个本身不是抽样的数字。
它是"涨价再回来"这件事的下界，而不是它的普查：先便宜、再贵、又回到便宜的那种步，不会被标上。

### 两个数据包各自展示了什么

这一节值得读两遍，也是仓库为什么发两个包而不是一个包的原因。

**`uniform.json` 是上游自己的世界。** `test.py` 这样造它的成功率表：

```python
model_result_array = np.random.randint(2, size=(G, n_data, 10))
```

——对每一个（模型，提示词）组合都是一枚公平硬币，于是五个模型都能解出大约一半的题目，最贵的那个
恰好和最便宜的那个一样值。在这样的世界里，根本没有值得升级*过去*的对象：正确的打法是调用最便宜的
模型，失败了就再调用它一次。这也正是路由器做的事，在 20 个 epoch × 1,000 步上测得：

| 学习器 | 效用 | 每步成本 | 每步解出 | 调用去了哪里 |
| --- | --- | --- | --- | --- |
| `promptwise` | **0.86339** | 1.528 | 0.9398 | 98.0% 给了最便宜的 `MODEL_B` |
| `lowest-cost` | 0.47765 | 0.750 | 0.5152 | 100% 给 `MODEL_B`，只调一次，不重试 |
| `highest-cost` | −0.13290 | 12.500 | 0.4921 | 100% 给最贵的 `MODEL_A` |
| oracle | 0.92164 | — | — | — |

每步 1.528、每次调用 0.75，就是 2.04 次调用，而其中 98% 打给了最便宜的模型：路由器在**重试**，
不是在升级。它的轨迹也这么说——epoch 0 的 1,000 步里，升级只有 **7** 次；由于抽样规则把每一次升级
都留下了，这个 7 是完整次数，而不是某个抽样的估计。花费翻了将近一倍、解出率也翻了将近一倍，在这里
是正确答案，而它并不是论文所讲的那个机制。

**`tiered.json` 只改了一件事：让模型之间有能力差。** 用每个模型自己的成功概率替换那枚公平硬币，
于是 `--tiers 0.88 0.32 0.82 0.50 0.56` 的意思是：`MODEL_A`（每次调用 12.50）解出 88%，
`MODEL_B`（0.75）解出 32%。这五个数字是**我们的**，不是论文的，包里的 `config.success_rates`
和 `source.data` 都写明了这一点。有了它们，升级立刻就出现了：

包里的每一个学习器都列出来，免得这张对比表是从"它赢得过的对手"里挑出来的：

| 学习器 | 效用 | 每步成本 | 每步解出 | 调用去了哪里 |
| --- | --- | --- | --- | --- |
| `GtS` | **0.70377** | 5.157 | 0.9616 | 贪心选一个，失败就重试到解出 |
| `promptwise` | **0.70214** | **2.208** | 0.8125 | 90.0% 给 `MODEL_B`，之后 9.2% 给 `MODEL_D` |
| `RtS` | 0.56592 | 8.480 | 0.9899 | 随机选一个，失败就重试到解出 |
| `ca-pak-ucb-tS` | 0.51062 | 9.336 | 0.9774 | 论文里用来对比的那个 bandit |
| `greedy` | 0.43015 | 3.115 | 0.5859 | 按当前最优猜测打一次 |
| `random` | 0.35194 | 5.165 | 0.6102 | 均匀随机打一次 |
| `lowest-cost` | 0.25800 | 0.750 | 0.2955 | 100% 给 `MODEL_B` |
| `highest-cost` | 0.24865 | 12.500 | 0.8737 | 100% 给 `MODEL_A` |
| oracle | 0.89043 | — | — | — |

**`GtS` 的效用比 `promptwise` 高 0.0016，而它为此多花了 2.3 倍的钱。** 这一行才是值得读的：
把它从表里拿掉再引用，第一个打开 demo 往下滚的人就能推翻你。这里的效用是
`解出率 − 0.05 × 成本`，所以在这个成本系数下，两者在合成指标上打平，而在论文真正关心的那件事上分开
了——`promptwise` 用 43% 的花费拿到了 `GtS` 84% 的解出率。你要哪一个，取决于你的预算;帕累托视图
存在的意义,就是让读者自己回答这个问题,而不是被告知答案。

还有三件事。路由器仍然从最便宜的模型开局——0.75 对 12.50，它本该如此——但这一次，失败之后它会往上
走：`MODEL_D` 拿到的调用占比从均匀世界里的 1.7% 升到这里的 9.2%，epoch 0 里有 **37** 次升级，
对面那个包只有 7 次，两个都是 1,000 步上的完整计数。两个固定策略最终只差 0.009，理由却正好相反——
一个便宜且常常做不对，一个昂贵且多半做得对，价钱算下来一样。而在 `uniform.json` 那个没有升级价值的
世界里，`promptwise` 是无争议的第一：0.86339,对 `GtS` 的 0.80098。

两个包没有哪个更诚实。上游那张表作为"学习器能不能跑起来"的冒烟测试完全合理，而路由器在它下面的行为
是正确的、不是退化的——值得明说：一个成本感知的路由器，在一个没有质量梯度的世界里，**本来就应该**
坍缩到最便宜的那个模型上。但一个只见过那个世界的读者，永远看不到论文真正要讲的东西。把两个并排发
出来，才是"这个算法到底做什么"的诚实版本。

### 参数

`--promptwise` 和 `--out` 是必填的；其余全部默认成 `test.py` 自己的默认值，所以什么都不加的一次运行
复现的就是它的配置。

| 参数 | 默认值 | 是什么 |
| --- | --- | --- |
| `--learners` | 全部八个 | `promptwise`、`ca-pak-ucb-tS`、`greedy`、`GtS`、`random`、`RtS`、`lowest-cost`、`highest-cost` 中的任意几个——就是上游 `LEARNER` 的键 |
| `--steps` | 1000 | `T`，每个 epoch 的提示词数 |
| `--epochs` | 20 | 曲线求平均所用的独立重复次数 |
| `--seed` | 1234 | 播种这个共享世界；此后每个 epoch 用 `seed + epoch` 重新播种 |
| `--tiers A B C D E` | 关闭 | 按池内顺序给出的每个模型的成功概率。不给，成功率表就是上游那张均匀的 `randint(2, …)` |
| `--cost-para` | 0.05 | `cost_para`：一单位花费相对于一次解出值多少 |
| `--rd-budget` | 5 | 路由器放弃一条提示词之前最多可以调用几次 |
| `--n-data`、`--dim` | 164、768 | 提示词池的大小，和向量维度 |
| `--kernel-method`、`--reg-method`、`--tau-exp`、`--exp-para` | `rbf`、`klr`、1、`None` | 原样透传给学习器 |
| `--keep-first`、`--sample-every` | 50、20 | 轨迹抽样规则；升级不受它约束，一律保留 |

`MODEL_SET` 和 `MODEL_COST` 刻意**不是**参数。那是 `test.py` 的五个名字和五个价格，在这里和在那里
一样是写死的，因为改动它们会让这些曲线与作者跑过的任何东西都失去可比性。

### 署名

PromptWise 出自 Xiaoyan Hu、Lauren Pick、Ho-fung Leung 和 Farzan Farnia
（[arXiv:2505.18901](https://arxiv.org/abs/2505.18901)），MIT 许可。AgentLens 没有内置它的任何代码：
这个脚本从你自己提供的 checkout 里 import，而 `public/demo-data/promptwise/` 下的数据包里只有我们
自己这次运行产生的数字。完整条款见 [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md)。
