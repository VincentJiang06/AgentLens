# AgentLens

[English](README.md) · **中文**

一个本地优先的查看器，用来读大模型与智能体研究留下的产物——评测日志、智能体轨迹、记忆库、路由决策。

研究代码会吐出大量没人愿意读的 JSON。通常的办法只有三种：在编辑器里翻一个 22 MB 的文件、
再写一个一次性的 notebook，或者把它传到别人的服务器上。AgentLens 是第四种：打开一个静态网页，
把文件拖进去，直接看。

> **数据全部留在你的浏览器里，不会上传。**

---

## 进度

**M0 — 外壳。** 拖入、格式嗅探、容错解析、虚拟滚动、深链和部署，这些就是交付物。

**M1 — RM-R1 适配器。** `rm-r1` 能读 RM-R1 评测脚本写出的全部四类日志（RewardBench、
RM-Bench、RMB pairwise、RMB best-of-n），以及它们旁边的官方分数文件，并给出三个视图：
逐条判例连同它的评分细则、引证片段和判定；从该运行自身的结果重算出的基准分数；以及两个运行的对照。
两个演示包会打开它——一个是单次运行，一个是两个 checkpoint 的对照。

**M2 — PromptWise 适配器。** `promptwise` 读一次 PromptWise 成本感知路由器的运行，给出三个视图。
一是四条学习曲线——效用、成本、成功率和最优选择率对 *t*——每个学习器一条线，oracle 画成上限而不是
第九个竞争者。二是成本／成功率平面，每个学习器一个带标签的点，尺寸是按"被粘进邮件里也还看得清"
来定的，并且自带图注，因为截图会脱离页面独自旅行。三是决策回放：一条提示词一行，按顺序列出它用掉的
那串调用；凡是路由器当时有估计的调用，都给出它在做出选择的那一刻对全部五个模型的看法——而
`utility = 1 − cost_para × cost / q` 这个恒等式是拿包里自己的数字重算出来的，不是断言出来的。
论文讲的那个升级动作，就是这串调用：先试便宜的，失败了才轮到贵的。

PromptWise 开源了算法而没有开源实验流程——`utils/aux.py` 定义了 `save_stats`，却没有人调用它——
所以这里根本没有一种现成的日志格式可供适配。数据包由
[`scripts/promptwise-runner/run.py`](scripts/promptwise-runner/README.md) 产出：它从你自己提供的
checkout 里原样驱动他们的类，把那些从未被保存的曲线、以及那些根本没被记录过的决策，一并写下来。

**M3 — ArbiterOS 适配器。** `arbiteros` 读的是把 ArbiterOS 的红队用例集放回 ArbiterOS 自己的
策略内核里重放一遍的结果——105 条用例、500 条 instruction——并把内核为每条用例算出来的东西显示
出来：每一条 instruction 连同它被赋予的安全标签，标签沿 `reference_tool_id` 引用链的传播
（可信度取沿途最小值，机密度取最大值），以及在某一步的传播后标签与它为自己声明的标签不一致时，
是哪个上游把它改了。点出那个上游正是画这条链的全部意义：500 步全都带标签，但其中只有 26 步带着
一个"要由更早某一步负责"的标签。旁边是策略链对这条用例的结论，以及判决里出现的每条策略在内核源码
里的位置。

之所以必须重放而不能只读用例文件，正是因为这些标签。磁盘上的一条用例是 `trace_id`、`prior` 和
`current`——一份攻防剧本，关于 taint 什么都没有。`prop_trustworthiness` 和
`prop_confidentiality` 不在任何一个文件里；它们要等内核重放过这条用例之后才存在。
[`scripts/arbiteros-runner/run.py`](scripts/arbiteros-runner/README.md) 就是这次重放，
而它不调用任何模型：不需要 API key，不需要网关，不消耗 token，不花钱。这是实测出来的，不是假定的，
怎么测的写在那个 README 里。

`arbiteros-preview` 保留，并没有被它取代。它读的是未经重放的原始用例文件，一条一行地列出来；
那与重放结果是**不同的东西**，而不是它的子集：一条用例是攻击本身，是它的作者写下的样子，
还没有被任何内核碰过。保留它同时也让所有已经发出去的 `?demo=arbiteros-preview` 链接继续有效，
而且它仍然是外壳与适配器之间那道接缝最小的一个范例——一个注册进来的适配器，自己嗅探数据、
自己建模型、自己渲染视图，而不是走回退路径——[写一个适配器](#写一个适配器)指的就是它。

其余一律走回退。今天拖入一个 RecMem 日志，得到的是通用记录浏览器加一棵可折叠的 JSON 树，
因为那个适配器还不存在。见[路线图](#路线图)。

### 演示数据从哪里来

**RM-R1 和 ArbiterOS 这两个演示是真实数据；两个 PromptWise 包是合成的，而且只有它们是合成的。**
这两件事都写在屏幕上：任何一个演示打开着的时候，页面都会标出它的数据来源，而 PromptWise 的包把
"这是合成数据"的声明放在自己的出处块里，用运行脚本自己的措辞渲染出来，不做改写。

`public/demo-data/rm-r1/` 下的 RM-R1 包由
[`scripts/build-demo-data/rm-r1.mjs`](scripts/build-demo-data/rm-r1.mjs) 从
[RM-R1-UIUC/RM-R1](https://github.com/RM-R1-UIUC/RM-R1) 公开的评测日志（Apache-2.0）构建。
这个脚本放在仓库里，是为了让抽样可以被质疑，而不是被将就地信任：除了唯一一次写明的截断之外，
每条记录都是源对象的原样，抽样规则写在包里，而被截断的那一条自己会说明这件事。

ArbiterOS 有两个数据包，都来自
[cure-lab/ArbiterOS](https://github.com/cure-lab/ArbiterOS)（Apache-2.0，版本 `78a8f98`），
但它们是两类不同的东西。预览版那个演示是他们的 105 条红队用例，合并成一个 JSON 数组，此外未作
改动——那是他们的文件。M3 那个演示里没有他们的任何一个文件：它装的是我们把这些用例重放一遍时，
他们自己的内核算出来的东西，标签和判决都是，由
[`scripts/arbiteros-runner/run.py`](scripts/arbiteros-runner/README.md) 对着你自己提供的 checkout
跑出来。两种情况下都没有内置 ArbiterOS 的任何代码。

这次重放的两端各有一个机械步骤，两个都得交代清楚，读者才谈得上信这份结果。用例里写死了
`/root/redteam/...` 这类路径，重放会先把它们改写到跑这次重放的那台机器上——用的是上游自己的批量
脚本在每条用例之前做的同一批替换——因为有好几条策略是按**文件在哪儿**来匹配的，不做改写就重放，
等于几乎什么都触发不了，数据包会描述出一个从不触发的策略引擎。然后，在写出任何一个字节之前，
这些路径又被改写回 `<redteam>`、`<arbiteros-kernel>`、`<openclaw-home>` 这几个占位符，于是发布出去的
数据包里不含任何一条属于运行者的路径；运行脚本会数一遍还剩下多少，只要还剩一条就拒绝写文件。
这两步都在[运行脚本的 README](scripts/arbiteros-runner/README.md) 里论证过。

署名、许可证和所做的改动都在
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 里；只要其中任一个演示打开着，页面上就会标出
数据来源。如果 ArbiterOS 的维护者不希望其中任何一份被再分发，提一个 issue，它会被移除。

用真实数据是有意的选择——一个只在编造记录上演示过的查看器，说明不了它能不能读你的日志——
但代价是每一次都要交代这是谁的数据。

`public/demo-data/promptwise/` 下的 PromptWise 包是这条规则的例外，而这个例外是有理由的：一个在线
路由器做什么，取决于算法和价格，不取决于任何一份数据集，PromptWise 自己的 `test.py` 正是出于这个
理由才在生成数据上做演示。所以这里的提示词是随机的 768 维向量，一个模型解不解得出某道题是生成的
一次抛硬币，而 `MODEL_A`…`MODEL_E` 是上游自己的占位名，原样保留——把它们改成真实厂商的名字，
等于凭空造出一个断言。**两个包里没有任何一个数字是某个模型的真实准确率，也没有一个数字复现了论文
里的图**——这句话是包自己说的，而且适配器把它放在第一张图之前，不是放在脚注里。之所以发两个包，
是因为这一对本身就是结论：在上游那张成功率表上，五个模型一样好，于是路由器正确地锁定最便宜的那个
并反复重试，只有当模型之间真的有差别时，升级才会出现。完整的论证、实测的数字，以及运行脚本与
`test.py` 唯一的一处不同，都在
[`scripts/promptwise-runner/README.md`](scripts/promptwise-runner/README.md)。

### 屏幕上的数字是对谁算的

演示包是抽样的，所以它显示的每个数字都必须交代分母。包和适配器共同遵守的规则是：
**在抽样样本上算出来的数字，永远不许挂基准的名字。**

之所以负担得起这条规则，是因为一个包分成两半。判例的完整文本——问题、两个回答、
Chain-of-Rubrics 推理过程——是抽样的，凡是从这些文本里读出来的都属于样本：判例浏览器的列表、
它的各种计数与筛选、样本自身的准确率。但源文件里**每一条**记录的结果（位置、`id`、子集或领域、
判对还是判错，再加上 RewardBench 的 A/B 位置打乱标记和 RM-Bench 三个风格文件的结果）是完整打包的，
从不抽样。这两张结果表的代价是 RewardBench 2,985 行 102 KB、RM-Bench 1,327 行 72 KB，
而所有挂着榜单名字的数字都从它们算出来：RewardBench 的分子集准确率和四个大项，
RM-Bench 的 3×3 风格矩阵与 `hard_acc` / `normal_acc` / `easy_acc` / `total_avg_acc`，
以及在双检查点那个包里，运行间的一致性矩阵和它旁边按分组的移动——两张表按源文件位置连接，
算的是全部 2,985 条，而不是那 40 条带文本的记录。在随包发布的 32B 包上，
这些数字与该运行自己发布的分数文件逐位重合——全量 2,985 条上是 92.93%，
而只看样本会读成 65.52%，因为样本是故意多放了模型判错的例子。

对照视图里有一个数字仍然属于样本，它也就在自己旁边写着这件事：A/B 位置注记。
位置打乱标记确实在表里，但要跟它对着读的 `[[A]]`/`[[B]]` 字母只在文本里，
所以那个计数是在带文本的那些记录上算的。

有两条后果值得点名。官方分数按**运行**归属：同时载入两个 checkpoint 时，每个分数文件都留在
它自己的运行旁边，绝不合并；说不清属于谁的数字就不显示。以及，没有完整结果表的数据——
比如你自己拖进来的日志——只会得到“已载入记录自身的准确率”，并明确标成这样，
不给大项方块，也不与任何人发布的数字作差。

完整的论证，包括构建脚本会检查什么、拒绝写出什么，在
[`scripts/build-demo-data/README.md`](scripts/build-demo-data/README.md)。

PromptWise 的包也是同样一分为二，只是接缝的位置不同。每一条曲线和每一个最终数字都是在整场运行上
算的——每个学习器 20 个 epoch × 1,000 条提示词，归一化方式沿用 PromptWise 自己的 `save_stats`。
曲线底下那条决策轨迹则**只取 epoch 0，并且是抽样的**，规则写在包自己的 `trace_sampling` 块里：
开头 50 步，之后每 20 步一取，外加每一次升级，一次不落。正因为把升级全留下了，升级的计数才能是那个
epoch 的完整计数，而它周围的那些步仍然只是抽样——这是两个不同的断言，不会被混着讲。这一切底下还压着
一个方法学要点：每个学习器都在同一条提示词序列上重放，而上游的 `test.py` 并不这么做，所以
学习器之间的对照，算的是同一批任务。

ArbiterOS 那个包没有抽样——105 条用例、500 条 instruction 全在里面——所以它的问题不在分母，
而在于它的哪一个计数可以被读成"检出"。包里有四个计数，它们不是同一个数字的四种看法。

`intercepted` 是 1：105 条用例里，内核真正改写了的响应只有一个，
`openclaw_p9_process_poll_loop`，被 `RateLimitPolicy` 按 per-tool 额度拦下（`41>20`）。
这是随包配置**执行**了的部分。

`flagged` 是 66，它不是检出数。这句话是包自己说的，写在 `how_to_read_the_counts` 里，
适配器把它原样渲染出来，不做改写。66 里有 65 是 `UnaryGatePolicy` 把工具调用的参数按不同的键顺序
重新序列化了一遍，没有任何规则命中，也没有摘掉任何东西——这一条是在全部 105 条上核过的，不是抽样：
把每个 `arguments` 字符串解析回 JSON 之后，策略链拿到的响应与它交回的响应每一条都相等。
**这 65 次里，改变了任何东西的有 0 次。**

`wouldBlock` 就是内核的 `inactivate_error_type`：当一条策略本来会改写响应、而注册表把它登记成
"只观察"时，内核就把这条本该返回的拒绝记下来，并把原样的响应交回去。它在 105 条里有 87 条非空——
而 87 同样不是检出数，理由值得在引用它之前先弄清楚。`apply_policy_enforcement_mode` 在被它拦下的
那条策略自己没有产出拒绝文案时，会填上固定的一句 `policy would have modified the response`，
而那正是把 `flagged` 撑大的同一个参数规范化分支。在随包发布的这个数据包上数一遍：87 条里有 38 条
带着内核真正写出来的拒绝文案，另外 49 条带的只有那句兜底的固定文案，别的什么都没有。

所以真正该引用的结论，连同它需要的每一个分母是：**105 条用例里，有 39 条被某条策略产生了拒绝——
用例集标为 unsafe 的 45 条里占 21 条，标为 safe 的 60 条里占 18 条。这 39 条里有 1 条被执行了，
另外 38 条的拒绝被记录下来之后丢掉**，因为 `policy_registry.json` 把 15 条策略里的 11 条登记成
只观察——执行的那 4 条是 `RateLimitPolicy`、`RelationalPolicy`、`UnaryGatePolicy` 和
`AlignmentSentinelPolicy`。另有一件事单独算：105 条里有 9 条含有传播后可信度为 `LOW` 的
instruction；而整个用例集里没有任何一步被标为 `HIGH` 机密度，所以 taint 判据的那一半在这里从未命中。

这是一份"用 ArbiterOS 自己的默认配置、跑 ArbiterOS 自己的用例集"的覆盖报告，不是对内核的批评：
一个以观察为主的默认配置是站得住的默认配置，而知道它在哪些地方只是观察，是有价值的。上面每一个数字的
测量过程都在 [`scripts/arbiteros-runner/README.md`](scripts/arbiteros-runner/README.md) 里，
下面还有逐条策略的表。

## 隐私性质，说准确

这是一个静态站点。没有后端，没有数据库，没有账号，没有遥测，也没有任何形式的分析统计。

- 你的文件经浏览器的 `File` API 读取，在 Web Worker 里解析，始终不离开这个标签页。
  也根本没有一个上传接口可以送出去。
- 唯一的网络请求是加载页面本身；如果你打开自带的演示包，就再加上从同一个静态站点取那个演示文件。
- 这一点你可以验证而不必相信：打开 DevTools 的 Network 面板，照常操作，不会有东西发出去。
  或者直接读源码，里面没有任何指向第三方的 `fetch`。

这条性质是设计的出发点，不是脚注。评测日志里有提示词、模型输出，有时还有未发布的数据。
一个要求你上传这些东西的工具，是一个你在真实工作里用不了的工具。

## 跑起来

```bash
npm install
npm run dev        # http://localhost:5173/
```

```bash
npm run build      # 类型检查 + 打包到 dist/
npm run preview    # 按生产 base path 提供 dist/
npm run lint
npm test           # node --test，跑纯逻辑的解析与适配器内核
```

构建需要 Node 20.19+ 或 22.12+（CI 用 24）。`npm test` 直接用 Node 内置的类型擦除跑
TypeScript 测试文件，需要 Node 22.18+ 或 23.6+——没有测试打包器，也没有转译步骤。
开发环境是 Node 24。除此之外不需要任何配置：没有 API key，没有外部服务。

## 外壳做什么

**什么都能拖。** 多个文件或整个文件夹，JSON 数组、JSON 对象、JSONL 都行。

**解析不轻易放弃。** 解析完全在 Web Worker 里进行并分批回传，所以一个 22 MB 的数组不会卡住标签页。
真实的研究日志经常不是合法 JSON，因此严格解析失败并不是终点：解析器转入抢救解析，
把能救的记录救出来，并报告跳过了多少段。只救回一部分的文件会被**标记**为抢救解析——
部分恢复和干净解析不是同一个断言，界面不会悄悄把两者混为一谈。

**永不白屏。** 如果没有适配器认领这份数据，或者某个适配器在 `parse()` 或渲染中抛错，
记录仍然会在原始记录浏览器里显示出来，并在屏幕上写明原因。回退是一种正常结果，不是错误状态。

**中英双语。** 顶栏有一个语言开关，切换的是 AgentLens 自己的措辞；选择会被记住，
默认跟随浏览器语言。数据永远不翻译——子集名、领域、文件名、格式 id，
以及被评判模型和评判者写下的每一个字，都按它们到达时的样子渲染。翻译别人的日志等于误引，
而那正好是查看器要避免的事。这条边界写在 [`src/shell/lang.ts`](src/shell/lang.ts) 里并由类型强制：
AgentLens 自己的措辞所使用的类型带着两种语言，缺一种就构造不出来，
所以“翻了一半”是编译错误，而不是屏幕上的意外。演示数据包从另一侧遵守同一条规则：
包里的注记正是抽样交代落脚的地方，所以构建脚本把每一条都写成两种语言，少一边就拒绝发布。

**精确到你想给对方看的那一条。** `?demo=<demo-id>&record=<record-id>` 会预载一个演示包并选中一条记录，
于是邮件里的链接落在你想展示的那个案例上，而不是首页：

```
<your-pages-url>/?demo=arbiteros-preview&record=cases.json:57
```

记录 id 的形式是 `<file-name>:<index>`；RM-Bench 多一段，因为那里一条记录是三个判例，
每个风格文件一个。**只载入一个文件时**也接受裸下标，所以手工缩短过的链接照样能落地；
载入两个文件时同一个下标指向两条不同的记录，这时链接会被报成“没找到”，而不是替你猜一个。
`arbiteros-preview` 适配器额外接受用例自己的 `trace_id`，那是它在上游的名字。
`arbiteros` 则完全不用文件位置：一条记录就是一条用例，用清单给它的用例 id 来命名，
而 `<用例 id>:<步骤下标>` 指的是它里面的某一条 instruction——这样链接落在你想说的那个标签所在的
那一步上，而不是落在埋着它的那条用例上。
id 里刻意不含 `#`，否则浏览器会把它当作片段截掉——链接必须经得起被粘贴、被重打一遍、
被邮件客户端折行。这个构建不认识的 `?demo=`，以及匹配不到任何东西的 `?record=`，
都会在屏幕上说出来，而不是无声失败。

选中一条记录会就地改写 `?record=`，而不是压入一条历史记录，因此**复制链接**复制的
永远是屏幕上这一条，而“后退”仍然一次就离开演示，不用把你点过的每一行再走一遍。

## 测试

`npm test` 用 Node 内置的测试运行器（`node --test`）跑那些纯逻辑内核——不含 React、不碰 DOM 的文件，
它们与视图分开正是为了这个：

| 内核 | 它必须守住的东西 |
| --- | --- |
| [`shell/parse.ts`](src/shell/parse.ts) | 一段探针被判成哪种形状（JSON 数组、JSON 对象、JSONL）；干净的文件产出每一条记录且 `salvaged: false`；损坏的文件产出损坏点周围的记录，外加一个 `ParseProblem` 和 `salvaged: true` |
| [`adapters/rm-r1/cor.ts`](src/adapters/rm-r1/cor.ts) | Chain-of-Rubrics 解析器，它的有趣情形全是畸形输入——用例照抄自公开日志里真实存在的记录，然后在全部 2,985 条上做模糊测试 |
| [`adapters/rm-r1/metrics.ts`](src/adapters/rm-r1/metrics.ts) | 按 RM-Bench 汇总脚本自己的方式运行，能复现它发布的 `final_result.json`；这个复现是对照组，没有它，修正后的数字就只是一种说法 |
| [`adapters/rm-r1/model.ts`](src/adapters/rm-r1/model.ts)、[`compare.ts`](src/adapters/rm-r1/compare.ts) | 指纹识别、归一化、一个分数文件属于哪个运行、结果表、运行对齐，以及记录 id 的约定 |
| [`adapters/promptwise/model.ts`](src/adapters/promptwise/model.ts) | 认出一次路由器运行、把运行脚本的字段名归一化成视图要的名字，以及一个本该写明却没写明的包会被带着原因丢弃，而不是被补上一个零 |
| [`adapters/arbiteros-preview/model.ts`](src/adapters/arbiteros-preview/model.ts) | 同样是记录 id 的约定，包括 id 里不含 `#`，以及落空的深链会被如实报成落空 |
| [`adapters/arbiteros/model.ts`](src/adapters/arbiteros/model.ts) | 认出一个重放数据包、由 `parentId` 建出的传播图、在手工构造的链上取 min/max、一个传播后的标签该归到哪个上游头上，以及悬空的父节点或环会被当作数据如实报出来，而不是让程序转不出来 |

一个 22 MB 的日志能不能解析、一条发出去的深链解析到哪条用例，都不需要浏览器就能验证。
没有测试打包器；类型由 Node 自己擦掉。

多数测试数据是内联的，适配器测试另外会读本仓库自带的演示包。有 16 个测试要读 RM-R1 公开的真实日志，
它们**不在**本仓库里——那是别人的数据，而且有几个是几十兆。这 16 个只在
`AGENTLENS_REAL_LOGS` 指向那个目录时才跑，否则报告为 *skipped*，并在旁边写明原因。
跳过的测试从不算作通过的测试。

```bash
npm test                                                  # 真实日志的测试报告为 skipped
AGENTLENS_REAL_LOGS=/path/to/eval/result/<run-id> npm test
```

`AGENTLENS_REAL_LOGS` 指的是**单次运行**的目录——里面有 `reward_bench/`、`RM-Bench/`、`RMB/` 的那一层，
例如 `eval/result/RM-R1-Qwen2.5-Instruct-32B`——而不是它上面那层装着各次运行的目录。
需要两个运行的测试会自己从这里找到同级的另一个运行。指高一层，这些测试就找不到文件了。

这 16 个里有 3 个属于解析内核，也是唯一带体量断言的三个：

| 真实输入 | 结果 | 它验证什么 |
| --- | --- | --- |
| 15 MB JSON 数组（RewardBench `logs.json`） | 2,985 条记录，干净 | 虚拟列表在这个体量下必须依然顺滑 |
| 22 MB JSON 数组（一次 RM-Bench 运行） | 1,327 条记录，干净 | M0 必须扛住的最大文件；不能阻塞主线程 |
| 20 KB RMB 日志，**非法 JSON** | 2 条全部救回，标记为抢救解析 | 末尾大括号前多一个逗号，`JSON.parse` 直接抛错；抢救路径把两条都救回来，指出出错的字节位置，并把文件标为抢救解析 |

一条深链*解析成什么*在测试套件里，它*落在哪里*不在。多文件拖入、`?record=` 引起的滚动与聚焦，
以及回退用的记录浏览器，都是在浏览器里对着构建产物手工验证的。

## 架构

两层，两层之间的边界就是整个设计：

```
shell/      拖入 · 解析 worker · 嗅探 · 虚拟列表 · 路由 · 主题 · 语言 · RawTree
              ↓  ParsedFile[]
adapters/   rm-r1/ promptwise/ arbiteros/ arbiteros-preview/   ← 现在就有
            recmem/   ← M4
```

外壳对任何格式一无所知。适配器对文件加载、worker、抢救解析、路由和部署一无所知。
跨越这条边界的一切都声明在 [`src/types.ts`](src/types.ts) 里，它是两边共同的唯一事实来源；
适配器之间从不互相 import。

三份契约把它撑住：

1. **解析** — worker 把一个 `File` 变成 `ParsedFile`：`records`、`problems`、探到的 `shape`
   和一个 `salvaged` 标记。
2. **适配器** — 一个注册表把名字映射到 `Adapter`，由嗅探决定这份数据归谁。
3. **路由** — `?demo=` 和 `&record=` 被解析成一个 `RouteState`，交给适配器解释。用查询参数而不是路径，
   所以 GitHub Pages 不需要任何 SPA 重写规则。

### 写一个适配器

一个适配器就是 `src/adapters/` 下的一个目录和一个对象：

```ts
import type { Adapter, ParsedFile } from '../../types'

export const myAdapter: Adapter<MyModel> = {
  // 必须等于本适配器要填的那一行路线图 id —— `rm-r1`、`promptwise`、
  // `arbiteros`、`recmem` —— 否则首页会为它显示两张卡片：你的，
  // 和它没能匹配上的那张 "planned"。`<row>-<suffix>` 表示这是
  // `<row>` 的预览版，`arbiteros-preview` 正是靠这条与 `arbiteros` 并列，
  // 而首页不会把同一行宣传两次。
  name: 'recmem',
  label: 'RecMem memory stores',
  blurb: 'One line describing what this adapter reads.',

  // 0 = 不是我的，1 = 确定。每个文件只会传入头几条记录，
  // 所以在 22 MB 的文件上这一步也很便宜。若只靠字段指纹识别，
  // 记得把文件名参数加下划线：`noUnusedParameters` 是开着的。
  sniff(_fileName, firstRecords) {
    return looksLikeMine(firstRecords) ? 0.8 : 0
  },

  // 进来的是原始记录，出去的是你的视图需要的任何东西。允许抛错；
  // 外壳会接住并回退到原始记录浏览器。
  parse(files: ParsedFile[]): MyModel {
    return buildModel(files)
  },

  View: MyView, // FC<{ model: MyModel; recordId?: string }>

  demos: [
    {
      id: 'recmem',
      label: 'Sample store',
      path: 'demo-data/recmem/sample.json',
      // 必填。演示包再分发的是别人的数据，就得说清是谁的。
      credit: { text: 'Official memory dumps from …', href: 'https://…' },
    },
  ],
}
```

在 [`src/main.tsx`](src/main.tsx) 里挨着现有那行加一句 `register(myAdapter)` 完成注册——
注册发生在首次渲染之前，这样首页才能向注册表询问都有些什么。从这里开始，拖入、worker 解析、
抢救解析、嗅探、`?demo=`/`?record=` 路由和部署都已经替你做完了。

这段代码照抄即可编译；如果你改了它，`npm run build` 是仲裁者。

渲染不在此列：外壳把模型交给你的 `View` 之后就让开。如果你的视图是一个长列表，
用 [`shell/VirtualList`](src/shell/VirtualList.tsx)——它是泛型的，接收一个 `renderRow`，
但你得自己选择用它。把 5,000 条记录映射成 5,000 个 DOM 节点的视图，感受会和听起来一样糟。

**嗅探是怎么定下来的。** 一个文件如果在顶层声明了
`"agentlens_format": "<name>@<ver>"`，就直接交给对应的适配器——按约定，显式声明是唯一
让适配器打 1 分的情形——下限和排序在代码里强制，这个上限则不是。其余一律按字段指纹打分。
一次拖入被视为一份数据集，因此一个适配器的得分是它在各个文件上的**平均分**，
最高的那个只要越过置信下限（0.5，见 [`src/shell/sniff.ts`](src/shell/sniff.ts)）就获胜。
低于下限则没人拥有这份数据，它归原始记录浏览器——这也是一个完全合格的答案。

**演示包**放在 `public/demo-data/`，Vite 会把它复制进构建产物。`DemoPackage.path` 是相对站点
base（`import.meta.env.BASE_URL`）解析的，所以要带 `demo-data/` 前缀，如上例。按约定把包控制在
5 MB 以内，站点才加载得快——外壳不强制这一点，不过 RM-R1 的构建脚本会在自己的目录超过 4 MB 时
直接失败。

## 路线图

计划中有四个适配器，其中三个已经交付。放这张表是为了让项目的形状可读，不是为了宣称能力：

| 适配器 | 它将要读的产物 | 状态 |
| --- | --- | --- |
| `rm-r1` | RM-R1 奖励模型评测日志（RewardBench、RM-Bench、RMB） | 已交付 — M1 |
| `promptwise` | PromptWise 的成本感知模型路由决策，来自一次对他们学习器的运行 | 已交付 — M2 |
| `arbiteros` | ArbiterOS 智能体轨迹：instruction、安全标签及其传播，以及策略判决——来自对 Kernel 红队用例的一次重放 | 已交付 — M3 |
| `recmem` | RecMem 记忆库 | 计划中 — M4 |

还有第五个已注册的适配器，它不占路线图的一行：`arbiteros-preview` 读的是同一批红队用例未经重放的
样子，也就是它们作者写下的样子。它与 `arbiteros` 并存，而不是被后者取代，因为一条用例和这条用例的
一次重放是两样不同的东西。

RM-R1、PromptWise、ArbiterOS 和 RecMem 都是别人的系统。AgentLens 是一个独立的、只读的查看器，
用来看它们产出的东西；它不修改这些系统，也不属于它们。

## 部署

部署是两步，走完之前站点并不存在：

1. 推到 `main`。这会触发 [`.github/workflows/pages.yml`](.github/workflows/pages.yml)，
   由它构建并通过 `actions/deploy-pages` 把 `dist/` 发布到 GitHub Pages。
2. **仓库 → Settings → Pages → Source 必须选 “GitHub Actions”**——这一步只能手工做一次。
   工作流没法替你设置，在设好之前它构建出来的东西无处可发。

base 路径不算第三步。项目站点的地址是 `https://<user>.github.io/<repo>/`，而且这个路径区分大小写，
所以 [`vite.config.ts`](vite.config.ts) 里的 `base` 是从 `GITHUB_REPOSITORY` 推出来的——
Actions 一定会设这个变量：换个名字 fork 也不用改任何东西，资源路径就是对的。
那个文件里写死的字面量只是本地 `npm run preview` 的兜底。

把链接发给任何人之前，先打开部署好的地址，点一个演示卡片。

## 技术栈

React 19 + TypeScript + Vite，外加用于长列表的 `@tanstack/react-virtual`。此外没有别的，
也没有任何会联网的东西。M2 要画图表，但**没有**引入绘图库：PromptWise 的曲线是内联 SVG 折线，
这样每一个数字都还留在 DOM 里，屏幕阅读器和页面内搜索都够得着。M3 要画关系图，同样没有引入图库——
dagre 在 M0 就被拿掉了，也没有再回来。之所以负担得起，是因为这些图是什么样的图：105 条用例里最大的
一条是 41 条 instruction，而步序是内核自己编好的，于是一个轴是现成的，另一个轴是算术。
这是一个你自己算得出来的布局，不是一个需要别人替你解决的布局问题。依赖清单还是 M0 时的那三个包。
