# `recmem-export` — read a finished RecMem run off disk

| | produces | needs |
|---|---|---|
| `export.py` | one `recmem-run@1` JSON package | a RecMem run that has already finished, and `qdrant-client` |

It does not run RecMem. It calls no model, opens no network connection and costs
nothing — everything it writes was already on disk when the evaluation ended.

```bash
python export.py --run <dir holding the three stores> --conv-id <conversation id> \
  --stats <output>_token_stats.json --growth growth.jsonl \
  --out <repo>/public/demo-data/recmem/run.json
```

`--stats` and `--growth` are optional. A package without them still carries the
three memory layers and says which parts are missing rather than drawing an
empty chart.

Run it **after** the evaluation, never during: the embedded Qdrant store takes a
single-process lock on its directory, so an export that overlaps a run fails, and
so does a run that overlaps an export.

## Three things the plan got wrong about the data

Each was found by reading RecMem's source, and each changed what this script
does rather than how it does it.

### 1. `list_memories()` cannot produce the lineage

The obvious export path is `QdrantStore.list_memories()`. Its signature is
`(collection_name) -> List[str]`, and that is exactly what it returns — the
texts. It drops `point.id` and the entire payload, and the payload is where
`raw_ids` and `source` live. Exported through it, the three layers are three flat
lists of strings with no way to connect them.

So this script calls `client.scroll(..., with_payload=True)` directly and keeps
`point.id` alongside every remaining payload key, unrenamed.

### 2. `semantic.source` is the episode's text, not its id

Every layer's ids are `uuid.uuid4()`, so a reader expects `source` to be one.
It is not. `rec_mem.py:317` writes

```python
extra_payload = {"source": f"{episodic_memory}"}      # the episode's TEXT
```

and the merge path at `rec_mem.py:373` writes

```python
extra_payload={"source": f"{conv}-{new_episodic}"}    # conversation + episode
```

So the semantic → episodic edge is **recovered by matching strings**, and this
script records how each one was recovered:

| `sourceHow` | meaning |
|---|---|
| `exact` | the source is an episode's text, character for character. The only certainty here. |
| `suffix` | the source ends with an episode's text — the merge-path form. Longest match wins, so a short episode that happens to be a suffix of a longer one does not steal the edge. |
| `ambiguous` | the matched text belongs to more than one episode, so which one is unknowable from the package. |
| `unresolved` | a source is present and no episode matches it. |
| `absent` | the fact carries no source at all. |

A viewer that drew all five the same way would be claiming certainty the data
does not have. That is why the field ships rather than a plain edge.

### 3. `raw_ids` identifies a window, not an episode

`episodic_memory.py:125` appends the extra payload inside the per-episode loop:

```python
for episode in episodes:
    ...
    extra_payloads.append({"conversation": conversation, "raw_ids": raw_ids})
```

`conversation` and `raw_ids` do not change inside that loop. So when one
generation call produces three episodes, all three carry the same `raw_ids`, and
that list says which messages **the batch** came from — not which of them this
particular episode summarises. `counts.episodeWindows` is the number of distinct
`raw_ids` lists, and it is the honest denominator for "how many message groups
produced episodes".

## Two fields that are not what they look like

- **`total_questions` is always 0.** It is initialised and never incremented.
  This script drops it rather than shipping a zero someone would try to read.
- **The judge's tokens are not in `token_stats`.** The file covers the memory
  pipeline only, so a RecMem-vs-baseline comparison built from it alone
  understates both sides. The package records the omission.

## What is still needed

The adapter and its demo package need a real run: RecMem calls an LLM and an
embedding model, so producing `run.json` costs money (the plan budgets $5–10 on
`gpt-4o-mini` + `text-embedding-3-small`, smoke-tested at `--conv_limit 1`
first). This script is the part that needs no key, and it is finished — the run
is the remaining gate.

For a per-conversation growth curve the run also needs `--conv_workers 1`;
above one worker the token monitor is global and the curves interleave.

---

# `recmem-export` — 把跑完的 RecMem 结果从磁盘上读出来

| | 产出 | 需要 |
|---|---|---|
| `export.py` | 一个 `recmem-run@1` JSON 数据包 | 一次**已经跑完**的 RecMem 评测，以及 `qdrant-client` |

它不负责跑 RecMem。不调用模型、不联网、不花钱——它写出来的每一个字节，在评测
结束时就已经在磁盘上了。

```bash
python export.py --run <放着三个 store 的目录> --conv-id <对话 id> \
  --stats <output>_token_stats.json --growth growth.jsonl \
  --out <repo>/public/demo-data/recmem/run.json
```

`--stats` 与 `--growth` 可以不给。缺了它们的数据包仍然带着三层记忆，并且会写明
缺了哪部分，而不是画一张空图。

一定要在评测**结束之后**单独跑，不要和评测并行：嵌入式 Qdrant 对它的目录加的是
单进程锁，导出撞上评测会失败，评测撞上导出同样会失败。

## 关于数据，原计划错了三处

三处都是读源码读出来的，每一处改变的都是这个脚本**做什么**，而不是怎么做。

### 1. `list_memories()` 做不出血缘

最顺手的导出路径是 `QdrantStore.list_memories()`。它的签名是
`(collection_name) -> List[str]`，返回的也正是这个——一串文本。`point.id` 和整个
payload 都被丢掉了，而 `raw_ids` 与 `source` 恰恰住在 payload 里。用它导出，三层
记忆就是三份互不相干的字符串列表。

所以这个脚本直接调 `client.scroll(..., with_payload=True)`，把 `point.id` 连同
payload 里剩下的每个键一起保留，不改名。

### 2. `semantic.source` 是 episode 的正文，不是它的 id

每一层的 id 都是 `uuid.uuid4()`，所以读的人自然会以为 `source` 也是个 id。它不是。
`rec_mem.py:317` 写的是

```python
extra_payload = {"source": f"{episodic_memory}"}      # episode 的正文
```

而合并路径 `rec_mem.py:373` 写的是

```python
extra_payload={"source": f"{conv}-{new_episodic}"}    # 对话 + episode 拼接
```

所以 semantic → episodic 这条边是**靠字符串匹配还原出来的**，脚本会记录每一条是
怎么还原的：

| `sourceHow` | 含义 |
|---|---|
| `exact` | source 与某条 episode 的正文逐字相同。这里唯一确定的一档。 |
| `suffix` | source 以某条 episode 的正文结尾——合并路径的形态。取最长匹配，免得一条短 episode 恰好是长的后缀就把边抢走。 |
| `ambiguous` | 匹配到的正文同时属于多条 episode，从包里无法判断是哪一条。 |
| `unresolved` | 有 source，但没有任何 episode 与之匹配。 |
| `absent` | 这条事实根本没带 source。 |

把这五档画成同一种边，就是在宣称数据并不具备的确定性。这也是这个字段要随包发布
的原因。

### 3. `raw_ids`标识的是一个窗口，不是一条 episode

`episodic_memory.py:125` 把 extra payload 追加在逐条 episode 的循环**里面**：

```python
for episode in episodes:
    ...
    extra_payloads.append({"conversation": conversation, "raw_ids": raw_ids})
```

而 `conversation` 和 `raw_ids` 在这个循环里根本不变。所以一次生成调用产出三条
episode 时，三条带的是同一份 `raw_ids`——它说明的是**这一批**来自哪些消息，而不是
这一条 episode 概括了其中的哪几条。`counts.episodeWindows` 数的是不重复的
`raw_ids` 列表个数，"有多少组消息产出了 episode"该用的是这个分母。

## 两个名不副实的字段

- **`total_questions` 恒为 0。** 它被初始化之后再没被加过。脚本直接把它丢掉，而不是
  发布一个会被人试图解读的零。
- **judge 的 token 不在 `token_stats` 里。** 这个文件只覆盖记忆流水线，所以只拿它来
  做 RecMem 与基线的对比，会把两边都低估。数据包里写明了这处缺失。

## 还差什么

适配器和它的演示数据包需要一次真跑：RecMem 要调用 LLM 和 embedding 模型，所以产出
`run.json` 是要花钱的（计划里的预算是 $5–10，用 `gpt-4o-mini` +
`text-embedding-3-small`，并且先用 `--conv_limit 1` 打样）。这个脚本是其中不需要
密钥的部分，它已经写完了——剩下的关口是那次跑。

另外，想要 per-conversation 的增长曲线，跑的时候还得加 `--conv_workers 1`；超过一个
worker 时 token monitor 是全局的，几条曲线会串在一起。
