# 统筹项目与规则（dsh-plugin-steward）

把一句话的要求做成可核对的**规则卡**，写进对应的 `AGENTS.md`；顺带管项目计划、规则台账、跨文件检索与时间线。产物全是纯 markdown，可 diff、可 review、可带走。

> 术语说明：插件对外把这张卡叫「规则卡」；`steward_card` 工具的返回文本里仍写作「口径卡」，两者是同一个东西。改名是为了对外好懂，运行时文案故意没动。

## 它解决什么

1. 会话里说过「以后一律这样」，两天后自己都想不起来定过——规矩只活在对话里，没落盘。
2. 一个项目跨几天做，第二天想接着上次的进度，而不是从零再讲一遍。
3. 想让别的工具或同事也能读你的约定——它们读不了插件的私有数据库，只能读纯文本。

## 快速开始

从 npm 装（<https://www.npmjs.com/package/dsh-plugin-steward>）：

```bash
dsh plugin add dsh-plugin-steward
```

想跟进仓库最新提交（main 分支）：

```bash
git clone https://github.com/zou240/dsh-plugins
dsh plugin add ./dsh-plugins/plugins/steward
```

装完新开一个会话，说一句「以后回答我时先给结论」，模型会先出卡、把待确认的问题一次问完，再把这条写进 `~/.dsh/AGENTS.md`。

可选：把「某类说法」映射到你的某个工作区，让落点建议更准——把 `domains.example.json` 复制到 `~/.dsh/steward/domains.json` 后按需改。不配置也能用：说法里直接点名了某个已登记工作区就落到它，否则按用户级。

## 十个工具

| 工具 | 做什么 / 什么时候用 |
|---|---|
| `steward_card` | 把一句话的要求拆成必答维度，给出该写进哪个 `AGENTS.md` 的哪一节，并列出命中的现有规则、疑似冲突和这类事最容易漏的点。会话开头先用它，**不动文件、不下结论**。 |
| `steward_commit` | 把确认过的一条规则写进对应 `AGENTS.md`：先查重、写前备份、记台账，可选跑你自己的 `docs-lint` 门禁，最后回报文件与行号。 |
| `steward_plan` | 项目计划：`save` 写 `PLAN-*.md`（`merge`/`append`/`replace` 三种更新语义）、`get`/`list` 读、`update` 勾步骤记进度；**`check`** 检查六个必填节 / 档位 / 派单标记 / 交付类「文档用法矩阵」/ 状态与勾选矛盾；**`scaffold`** 生成骨架（六节齐全、交付类自带用法矩阵、步骤带 `[档位] [派单]` 占位）。 |
| `steward_search` | 跨所有 `AGENTS.md`、插件台账与 `PLAN-*.md` 检索原文，返回 `path:line`；回答「我之前是不是说过」不靠记忆。 |
| `steward_ledger` | 列出台账登记过的每条规则，并标注它在文件里还能不能找到（找不到 = 被手改或删了）。 |
| `steward_change` | **改动登记**：把一次改动写成 `~/.dsh/CHANGES.md` 一行（日期 / 对象 / 改了什么 / 证据 / 回滚 / 指针），可选同时把某项目 `STATUS.md` 的「最后更新」戳成现在；`action=list` 读最近几条。 |
| `steward_timeline` | 把台账改动、报错记录、计划、规定与**改动账本**按日期串成时间线，可直接生成工作区 `TIMELINE.md`。 |
| `steward_project` | **项目档案**：登记真源 / 生成物 / 冻结件 / 入口 / 口径 / 待办 / 门禁 / 计划（`~/.dsh/projects.json`），`show` 直接返回渲染好的当前态；所有项目文书从它派生。 |
| `steward_handoff` | **交接与收尾**：`status` 按档案 + 计划 + 账本 + 日志重写 `STATUS.md`（一个项目只留一份当前态）；`close` 冻结 `HANDOFF-<日期>.md`、STATUS 标「已收尾」、计划标 done、账本记一行。 |
| `steward_log` | **过程日志**：`~/.dsh/logs/<项目>.md`，`add` 追加运行输出 / 报错原文 / 决策理由，`list` 读最近几条；`steward_timeline` 会并入。 |

## 改动账本（为什么多这一层）

规则台账只记「口径」，计划只记「进度」，两者都不回答「这个项目/插件上次到底改了什么、另一个会话怎么知道」。`steward_change` 补的就是这一层：

- 写：一行一条，列固定 `日期 | 对象 | 改了什么 | 证据 | 回滚 | 指针`；「对象」用你门禁配置里的 key（如 `ego-merged` / `rules-user` / `tools-dsh`）。
- 读：`steward_timeline` 把账本当第四来源并入，跨会话一条线；`action=list` 可当场看最近几条。
- 把关：配套 `change-gate`（按 mtime 扫最近 N 天的改动，未登记即失败）不在插件里，属宿主侧门禁——插件只负责「记得写」和「读得到」。

## 项目统管（2026-11-03 起）

一个项目的东西只有一处正本，其余全部由它派生：

| 面 | 正本 | 谁写 / 谁读 |
|---|---|---|
| 项目本身 | `~/.dsh/projects.json` | `steward_project` |
| 计划 / 推进 | `<工作区>/PLAN-*.md` | `steward_plan` |
| 当前态 / 交接 | `<真源>/STATUS.md`｜收尾快照 `HANDOFF-<日期>.md` | `steward_handoff` |
| 改动 | `~/.dsh/CHANGES.md`（日期｜类型｜对象｜改了什么｜证据｜回滚｜指针） | `steward_change` → 门禁 + 时间线 |
| 过程日志 | `~/.dsh/logs/<项目>.md` | `steward_log` → 时间线 |
| 时间线 | `<工作区>/TIMELINE.md` | `steward_timeline publish` |
| 规则 | `AGENTS.md` + `~/.dsh/steward/ledger.json` | `steward_commit` |

### 写路径护栏（2026-11-03 审计后补）

- **拒写非 STATUS**：`handoff status` 只覆盖自己生成的文件（首行含「· 当前态（STATUS）」或生成说明行）；`statusFile` 指向手写文档（RUNBOOK / 使用说明 / PLAN / 旧 HANDOFF）时**直接拒绝并报错**，让人把档案改到 `<source>\STATUS.md`。写前整份备份到 `~/.dsh/steward/backups/`。
- **`projects.json` 原子写**：解析失败一律抛错，绝不「当成空表再写回去」；写盘走 `tmp + rename`，写前备份，`list` 报红而不是静默吞掉。
- **同日 `close` 不再覆盖**：`HANDOFF-<日期>.md` 已存在就写 `-2`、`-3`，冻结件只增不改。
- **收尾后拒写**：档案有 `closedAt` 时 `status` 拒绝重写（要改先 `update status=active` 复开）。
- **账本 key 别名**：档案可带 `ledgerKeys`（如 `ego-merged` / `ego-frozen` / `ego-package`），读改动账本时命中任一即算，不再出现「账本里没有这个项目的改动」。
- **注册即体检 + 可注销**：`register` 校验 source 是否存在、计划缺失只告警；`update` 只认白名单字段（拼错报错）；`action=remove` 带 `confirm:true` 才真删档案（不动项目文件）。
- **健康度**：`list` 逐项标「STATUS 缺失 / 源目录不在 / 计划缺失 / 已收尾 / 无门禁」；`show` 直接给渲染好的当前态。
- **设置页第三个 tab「项目」**：只读列出 key / title / status / 最后更新 / 健康度（数据走 `/steward/projects.json`）。

## 两处不靠模型自觉的机制

- **系统提示小节「规则纪律」**：所有会话常驻，要求先出卡再动手。
- **`agent/pre-step` 提醒**：消息里出现「记住 / 以后都 / 一律」这类明确规则语气时，本轮追加一条提醒，逼出 `steward_card`。设 `KOUJING_NO_REMIND=1` 可关。
- **语言**：上面两段注入文案默认跟随系统语言（`zh` 开头出中文，其余英文）。可用配置 `policyLanguage: auto|zh|en` 或环境变量 `KOUJING_POLICY_LANG` 强制。

## 数据在哪

| 东西 | 路径 |
|---|---|
| 规则正文 | `~/.dsh/AGENTS.md`（用户级）或 `<工作区>/AGENTS.md`（工作区级） |
| 台账索引 | `~/.dsh/steward/ledger.json`（只记来源、落点、时间） |
| 改动账本 | `~/.dsh/CHANGES.md`（跨会话的「改了什么」，`steward_change` 写、`steward_timeline` 读） |
| 写前备份 | `~/.dsh/steward/backups/` |
| 落点路由（可选） | `~/.dsh/steward/domains.json` |
| 项目计划 / 时间线 | `<工作区>/PLAN-*.md`、`<工作区>/TIMELINE.md` |

插件自身不建数据库。

> **`STATUS.md` / `HANDOFF-*.md` 只留本地，不随发布。** 这两份是项目内部当前态与收尾快照，内容含真源目录、profile 链接等**本机绝对路径**；发布仓库已用 `.gitignore` 的 `**/STATUS.md` 排除，`package.json` 的 `files` 白名单也不含它们。要对外分享时另出脱敏副本，别直接提交。

## 计划的三种更新模式（`save` 的 `mode`）

| mode | 未传的节 | 传了的节 | `steps` | 手写小节 |
|---|---|---|---|---|
| `merge`（默认） | 原样保留 | 整段替换 | 按文字精确相等并入：命中的只改文案，没传的旧步骤与 `[x]` 不动，新步骤追加 | 保留 |
| `append` | 原样保留 | 追加到节末（同一段已在则跳过） | 只追加 | 保留 |
| `replace` | 必填节填「（待补）」 | 整段替换 | 以传入为准 | 丢弃并在返回里报告 |

三条不变式：

- **进度记录永远不被 `save` 清空**（只有 `update` 追加）。
- 勾选状态以文件为准：只传步骤文字不会取消已勾的。
- `title` 决定文件名，改标题 = 另存一份新文件，不重命名旧文件。

## 与同类插件的区别

| 常见误解 | 实际 |
|---|---|
| 「又一个记忆插件」 | 不做自动召回、不做 embedding、不扫代码库。只读写你自己写的 `AGENTS.md` 与 `PLAN-*.md`。 |
| 「又一个会话管理插件」 | 不做分组、不归档、不动会话列表。 |
| 「又一个任务系统」 | 不替代宿主自带的 todo / goal。它管的是跨会话的长期约定，和能交接给人的计划文件。 |
| 「把规则塞进系统提示词」 | 产物是纯 markdown：可 diff、可 review、可带走，换工具也读得懂。这是它唯一真正的卖点。 |

## 常见问题

1. **会不会把我的规则改坏？** 写前备份到 `~/.dsh/steward/backups/`，只追加不重写；命中文档里已有相似条目会先提示再写。
2. **多工作区怎么决定写哪儿？** 默认按「换个工作区还成立吗」判（点名了工作区就落它，否则用户级），也可用 `workspace` 参数强制指定。
3. **计划改一句要整篇重写吗？** 不用：`merge`（默认）只并入改动的步骤，勾选与手写小节都保留。
4. **面板空白或 401？** 两个数据路由是同源只读接口，需要带会话令牌的页面访问；直连地址会 401，这是设计如此。
5. **能关掉自动提醒吗？** `KOUJING_NO_REMIND=1`。
6. **Windows 之外能用吗？** 纯 Node 实现，无原生依赖、不调外部程序；`docs-lint` 门禁是可选的，不存在就跳过。
7. **卸载会留下什么？** `~/.dsh/koujing` 下的台账与备份（删掉即净）；`AGENTS.md` 里的规则是你自己的文本，插件不删。

## 边界与限制

- 「像不像一条规定」是启发式判断（关键词 + 相似度），分类不准时用 `kind` 参数显式指定。
- **落点小节也是启发式的**：短句可能被放进「字面相近、语义其实不近」的节。落盘前核对小节，或用 `section` 参数显式指定。
- **查重只比同一个文件内**（相似度阈值较高）：别的文件 / 别的工作区里已有的等价规则不会自动标出来。看到「可能已有等价规则」时要人工确认，避免产生第二份副本。
- 只写「规则」，项目计划一律走 `steward_plan`，不混在一个工具里。
- 两个只读路由不提供写操作，面板不能编辑规则——改规则请走 `steward_commit`（有备份与台账）。

## 自测

```bash
node dev/smoke.mjs    # 核心逻辑（临时 HOME，不碰真实规则）
node dev/routes.mjs   # 两个只读路由的 200 / 401 / 放行
```

## 许可

MIT
