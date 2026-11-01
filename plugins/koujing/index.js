/**
 * dsh-plugin-koujing —— 「口径」：用户说要求 / 规定 / 项目时，先出卡，不靠猜。
 *
 * Host 半：
 *   koujing_card     只读：生成口径卡（维度清单 + 落点 + 命中的现有规则 + 盲点）
 *   koujing_commit   写入：把确认过的规定落进对应 AGENTS.md（备份 + 查重 + 台账 + docs-lint）
 *   koujing_search   只读：跨所有 AGENTS.md / 台账检索规则原文
 *   koujing_ledger   只读：台账清单，标注每条在文件里还在不在
 *
 * 另加两处“不由模型自觉”的部分：
 *   systemPrompt 小节   常驻口径纪律（所有会话可见）
 *   agent/pre-step      命中“记住 / 以后都 / 一律”这类明确规则语气时，
 *                       在本轮消息后追加一条提醒，逼出 koujing_card（KOUJING_NO_REMIND=1 可关）
 */
import crypto from 'node:crypto';
import path from 'node:path';
import {
  blindspotsFor,
  checklist,
  commitRule,
  detectKind,
  findConflicts,
  ledgerPath,
  ledgerReport,
  looksLikeRule,
  pickPlacement,
  pickSection,
  readLedger,
  searchRules,
} from './lib/core.js';
import { getPlan, listPlans, savePlan, updatePlan } from './lib/plan.js';
import { buildTimeline, publishTimeline, renderTimelineMarkdown } from './lib/timeline.js';

export const inject = ['tools', 'systemPrompt'];

const KIND_LABEL = { rule: '规定', requirement: '要求', project: '项目' };

// 注入给模型的两段文案（系统提示小节 + pre-step 提醒）按语言出中/英两套。
// 桌面端默认中文；英文环境不再被塞中文指令。可用配置 policyLanguage 或环境变量 KOUJING_POLICY_LANG 覆盖。
const POLICY_ZH = [
  '## 规则纪律',
  '',
  '用户陈述要求、规定，或开始一个项目时：',
  '',
  '1. 先调用 `koujing_card`（statement 填用户原话），不要先改文件、不要先给结论。',
  '2. 按返回的 checklist 逐项标「已明确 / 待确认」；待确认项一次性用 `ask_user_question` 问完，每题给出默认建议。',
  '3. 用户答完或说「按默认」后：属规定 → `koujing_commit` 落盘并回报文件与行号；属项目 → 用 `koujing_plan` save 成工作区的 PLAN-*.md。',
  '4. 开始或接着做一个多步项目前，先 `koujing_plan` get 读计划，按计划推进；要改计划用 save + mode=merge（只传变化的那几节 / 新步骤，旧内容与勾选保留），不要为改一句就整篇重写；日常打点用 update。',
  '5. 没问过的维度不许当成已确定；用户说「你自己定」才用默认值，并在汇报里写明替你定了什么。',
].join('\n');

const POLICY_EN = [
  '## Rule discipline',
  '',
  'When the user states a requirement or a standing rule, or starts a project:',
  '',
  '1. Call `koujing_card` first (statement = the user wording as given). Do not edit files or state a conclusion beforehand.',
  '2. Mark every checklist item as settled or open; ask all open items in one `ask_user_question` round, each with a suggested default.',
  '3. After the answers (or when the user says "use defaults"): for a rule, write it with `koujing_commit` and report the file and line numbers; for a project, save a plan with `koujing_plan` into the workspace as PLAN-*.md.',
  '4. Before starting or resuming a multi-step project, read the plan with `koujing_plan` get and follow it. To change it, use save with mode=merge (pass only the changed sections or new steps; keep existing text and check marks). Use update for day-to-day progress.',
  '5. Never treat an unasked dimension as settled. Use defaults only when the user says so, and say in the reply which defaults you chose.',
].join('\n');

const REMIND_ZH =
  '【规则提醒·自动】这条消息像是一条规定或要求。先调用 `koujing_card`（statement = 用户原话），' +
  '把卡片里「待确认」的维度用 `ask_user_question` 一次问完（每题带默认建议），再决定落盘或开工。' +
  '不要在没出卡前直接执行或下结论。';

const REMIND_EN =
  '[Rule reminder · automatic] This message looks like a standing rule or requirement. Call `koujing_card` first ' +
  '(statement = the user wording), ask all open checklist items in one `ask_user_question` round (each with a suggested default), ' +
  'then decide whether to write it or start the work. Do not act or conclude before the card.';

/** Cordis 里没声明注入时读 ctx.config 会抛（不能当成 undefined），所以单独兜一层。 */
function readConfig(ctx) {
  try {
    return ctx?.config ?? undefined;
  } catch {
    return undefined;
  }
}

/** auto = 跟随系统语言（zh 开头用中文，其余英文）；配置 policyLanguage 或 KOUJING_POLICY_LANG 可强制。 */
function pickLang(ctx) {
  const want = String(readConfig(ctx)?.policyLanguage ?? process.env.KOUJING_POLICY_LANG ?? 'auto').toLowerCase();
  if (want === 'zh' || want === 'en') return want;
  const tag = String(
    process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale || '',
  ).toLowerCase();
  return tag.startsWith('zh') ? 'zh' : 'en';
}

// 规则语气判定统一走 core.looksLikeRule()，这里不再维护第二份正则——
// 两份各写一遍的下场是「以后必须 / 每次都要」能建卡却弹不出提醒。

function textOf(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (typeof b === 'string' ? b : b?.type === 'text' ? b.text : ''))
    .join('\n');
}

function cardText(card) {
  const L = [];
  L.push(`口径卡 · ${KIND_LABEL[card.kind] ?? card.kind}`);
  L.push('');
  L.push(`落点：${card.placement.file}`);
  L.push(
    card.placement.isPlan
      ? `说明：${card.placement.sectionReason}`
      : `小节：## ${card.placement.heading}（${card.placement.sectionReason}）`,
  );
  L.push(`理由：${card.placement.reason}`);
  L.push('');

  const given = card.dims.filter((d) => d.status === 'given');
  const missing = card.dims.filter((d) => d.status !== 'given');
  L.push(`必须明确（${given.length} 已明确 / ${missing.length} 待确认）`);
  for (const d of card.dims) {
    if (d.status === 'given') {
      L.push(`  ✓ ${d.label}：${d.value}`);
    } else {
      L.push(`  ? ${d.label}：${d.question}`);
      L.push(`     默认：${d.fallback}`);
    }
  }
  L.push('');

  if (card.conflicts.length) {
    L.push(`相关 / 疑似冲突（${card.conflicts.length}）`);
    for (const c of card.conflicts) {
      L.push(`  ${c.file}:${c.line}  ${c.heading ? `[${c.heading}] ` : ''}${c.text.slice(0, 120)}  （相关度 ${c.score.toFixed(2)}）`);
    }
    L.push('');
  }

  if (card.spots.length) {
    L.push(`你可能没想到的（${card.spots.length}）`);
    card.spots.forEach((s, i) => {
      L.push(`  ${i + 1}. ${s.risk} —— ${s.why}`);
      L.push(`     问：${s.question}  默认：${s.fallback}`);
    });
    L.push('');
  }

  L.push(
    card.kind === 'rule'
      ? '下一步：把「待确认」项一次问完（或用户说「按默认」），确认后用 koujing_commit 落盘。'
      : '下一步：把「待确认」项一次问完（或用户说「按默认」），然后带着这张卡开工。',
  );
  return L.join('\n');
}

function buildCard(args) {
  const statement = String(args?.statement ?? '').trim();
  if (!statement) throw new Error('statement 不能为空');
  const kind = args?.kind && args.kind !== 'auto' ? args.kind : detectKind(statement);
  const placement = pickPlacement(statement);
  if (args?.workspace) {
    placement.scope = 'workspace';
    placement.wsPath = String(args.workspace);
    placement.wsTitle = String(args.workspace).split(/[\\/]/).filter(Boolean).pop() ?? 'workspace';
    placement.file = `${String(args.workspace).replace(/[\\/]+$/, '')}\\AGENTS.md`;
    placement.reason = `调用方指定了工作区：${placement.wsTitle}`;
  }
  const section = pickSection(placement.file, statement);
  const isPlan = kind === 'project';
  const finalPlacement = isPlan
    ? {
        ...placement,
        isPlan: true,
        file: placement.wsPath ? path.join(placement.wsPath, 'PLAN-<名字>.md') : '（先确定工作区，save 时用 workspace 指定）',
        heading: '',
        sectionReason: '项目计划存工作区根目录的 PLAN-*.md，文件名由 koujing_plan save 的 title 决定',
      }
    : { ...placement, heading: section.heading, sectionReason: section.reason };
  return {
    kind,
    statement,
    placement: finalPlacement,
    dims: checklist(kind, placement, statement),
    conflicts: findConflicts(statement),
    spots: blindspotsFor(statement, kind),
  };
}

const PARAMS = {
  card: {
    type: 'object',
    properties: {
      statement: { type: 'string', description: '用户原话或需求摘要，尽量原文，不要自己改写' },
      kind: {
        type: 'string',
        enum: ['auto', 'rule', 'requirement', 'project'],
        description: 'auto 按语气判断；规定=长期生效的规则，要求=本次交付要求，项目=多步工程',
        default: 'auto',
      },
      workspace: { type: 'string', description: '可选：强制把落点定到某个工作区目录（绝对路径）' },
    },
    required: ['statement'],
    additionalProperties: false,
  },
  commit: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '一句话标题，进台账用' },
      body: { type: 'string', description: '规定的正文（一行，不带 - 前缀）' },
      scope: { type: 'string', enum: ['user', 'workspace'], description: '用户级写 ~/.dsh/AGENTS.md；工作区级写 <wsPath>/AGENTS.md' },
      wsPath: { type: 'string', description: 'scope=workspace 时必填，工作区绝对路径' },
      section: { type: 'string', description: '可选：指定二级标题名；不给他会自己挑最接近的' },
      tags: { type: 'array', items: { type: 'string' }, description: '可选标签' },
    },
    required: ['title', 'body', 'scope'],
    additionalProperties: false,
  },
  search: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '关键词，空格分隔多个' },
      limit: { type: 'number', description: '最多返回多少条，默认 20' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  ledger: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['all', 'stale'], description: 'all=全部；stale=只看文件里已经找不到的', default: 'all' },
    },
    additionalProperties: false,
  },
  plan: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['save', 'list', 'get', 'update'],
        description: 'save=建立或增量更新计划；list=列计划；get=读全文；update=标步骤/改状态/记进度',
      },
      mode: {
        type: 'string',
        enum: ['merge', 'append', 'replace'],
        description:
          'save：更新语义。merge（默认，已存在的计划一律用它）=未传的节原样保留、传了的节整段替换、steps 按精确文字并入（没传的旧步骤与勾选保留）；append=传了的节追加到节末、steps 只追加不改文案；replace=整篇重写（未传的必填节填空、按需节删除、手写小节丢弃）',
      },
      workspace: { type: 'string', description: '工作区绝对路径；save 省略时用当前会话的工作目录' },
      title: { type: 'string', description: 'save：计划标题（决定文件名 PLAN-<标题>.md）' },
      goal: { type: 'string', description: 'save：目标与成功标准' },
      gap: {
        type: 'string',
        description:
          'save（按需）：差距对照——对标某个方案/竞品时，逐项写「它有什么 / 我们现状 / 判定（缺·弱·相当·我们更强·不做）/ 落点」，只在补齐、选型、移植类项目加',
      },
      scope: { type: 'string', description: 'save：范围（做 / 不做）' },
      steps: {
        type: 'array',
        items: { type: 'string' },
        description:
          'save：按顺序的步骤；已完成的写 "[x] 内容"。merge/append 下只传要新增或改动的步骤即可，没传的旧步骤与勾选状态保留；要删步骤才用 mode=replace',
      },
      modes: {
        type: 'string',
        description:
          'save（按需）：执行档位——预计跨 5 步以上或需要切推理档时，逐步骤写建议档位（High/Max）与理由、以及切换节奏',
      },
      accept: { type: 'string', description: 'save：验收方式' },
      risks: { type: 'string', description: 'save：风险与回滚' },
      status: { type: 'string', enum: ['active', 'paused', 'done'], description: 'save/update：计划状态' },
      plan: { type: 'string', description: 'get/update：计划绝对路径，或计划名（PLAN-xxx.md / xxx）' },
      progress: { type: 'string', description: 'update：追加一条带时间的进度记录' },
      step: { type: 'string', description: 'update：步骤序号（如 "3"）或步骤文字片段' },
      done: { type: 'boolean', description: 'update：配合 step，true=勾选（默认），false=取消勾选' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  timeline: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['events', 'markdown', 'publish'],
        description: 'events=按时间列事件；markdown=输出完整时间线文档；publish=写进工作区 TIMELINE.md',
      },
      workspace: { type: 'string', description: 'publish 时写到哪个工作区，省略用当前会话的工作目录' },
    },
    required: ['action'],
    additionalProperties: false,
  },
};

function workspaceOf(ctx, exec, arg) {
  if (arg) return String(arg);
  try {
    const wd = ctx.get('workingDirectory');
    const session = exec?.agent?.session;
    if (wd && session) return wd.get(session);
  } catch {
    /* 退回到显式参数 */
  }
  return undefined;
}

const OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '（完成）') }],
};

const TOOLS = [
  {
    name: 'koujing_card',
    description:
      '把用户的一句话变成口径卡：列出必须明确的维度、建议落点（用户级 / 哪个工作区、哪一节）、命中的现有规则、疑似冲突，以及这类事最容易漏的盲点。只读，不写文件。用户提出要求 / 规定 / 项目时先调用它。',
    parameters: PARAMS.card,
    isConcurrencySafe: () => true,
    run: async (args) => {
      const card = buildCard(args);
      return { text: cardText(card), card };
    },
  },
  {
    name: 'koujing_plan',
    description:
      '项目计划：save 把口径卡写成工作区根目录的 PLAN-<名字>.md（可回读、可交接）；已存在的计划用 save + mode=merge 增量改（只传变化的那几节/新步骤，旧内容与勾选保留，不要整篇重写），mode=append 往节末追加、mode=replace 才整篇覆盖；list 列现有计划；get 读全文；update 勾步骤 / 改状态 / 记进度。必填节：目标 / 范围 / 步骤 / 验收 / 风险回滚；按需节：gap=差距对照（对标、选型、移植类项目才写）、modes=执行档位（跨 5 步以上或要切推理档时写）。开始或接着做一个多步项目时先 get 一次，按计划推进。',
    parameters: PARAMS.plan,
    isConcurrencySafe: () => false,
    run: async (args, exec, ctx) => {
      const action = args?.action;
      if (action === 'list') {
        const ws = args?.workspace ? String(args.workspace).toLowerCase() : '';
        const rows = listPlans().filter((p) => !ws || p.workspace.toLowerCase() === ws);
        if (!rows.length) return { text: '还没有计划文件（PLAN-*.md）。项目开始前用 save 建一份。', rows };
        const L = [`计划 ${rows.length} 份：`];
        for (const p of rows) L.push(`- [${p.status}] ${p.title}  (${p.steps ? `${p.doneSteps}/${p.steps}` : '无步骤'})  ${p.file}  更新 ${p.updated}`);
        return { text: L.join('\n'), rows };
      }
      if (action === 'get') {
        const r = getPlan(args?.plan);
        return { text: `计划文件：${r.file}\n\n${r.text}`, plan: r };
      }
      if (action === 'update') {
        const target = String(args?.step ?? '').trim();
        const stepArg = target ? (/^\d+$/.test(target) ? Number(target) : target) : undefined;
        const r = updatePlan({
          ref: args?.plan,
          status: args?.status,
          progress: args?.progress,
          stepDone: args?.done === false ? undefined : stepArg,
          stepUndone: args?.done === false ? stepArg : undefined,
        });
        const done = r.steps.filter((s) => s.done).length;
        return {
          text: `已更新计划：${r.file}\n状态：${r.status}　步骤：${done}/${r.steps.length}${args?.progress ? `\n进度：${args.progress}` : ''}`,
          result: r,
        };
      }
      if (action === 'save') {
        const ws = workspaceOf(ctx, exec, args?.workspace);
        if (!ws) throw new Error('save 需要 workspace（当前会话没有可用工作目录时请显式传）');
        const r = savePlan({
          workspace: ws,
          title: args?.title,
          goal: args?.goal,
          gap: args?.gap,
          scope: args?.scope,
          steps: args?.steps,
          modes: args?.modes,
          accept: args?.accept,
          risks: args?.risks,
          status: args?.status,
          mode: args?.mode,
        });
        const L = [`${r.created ? '已建立' : '已更新'}计划：${r.file}（${r.mode}）`];
        const s = r.steps;
        if (r.created) {
          L.push(`- 步骤：新建 ${s.after} 条`);
        } else {
          const detail = [];
          if (s.matched) detail.push(`命中 ${s.matched}`);
          if (s.added) detail.push(`新增 ${s.added}`);
          if (s.kept) detail.push(`保留 ${s.kept}`);
          if (s.toggled) detail.push(`改勾选 ${s.toggled}`);
          L.push(`- 步骤：${s.before} → ${s.after}${detail.length ? `（${detail.join('、')}）` : ''}`);
        }
        if (r.sections.replaced.length) L.push(`- 替换节：${r.sections.replaced.join('、')}`);
        if (r.sections.appended.length) L.push(`- 追加节：${r.sections.appended.join('、')}`);
        if (r.sections.keptExtras.length) L.push(`- 保留手写节：${r.sections.keptExtras.join('、')}`);
        if (r.sections.droppedExtras.length) L.push(`- 丢弃手写节：${r.sections.droppedExtras.join('、')}`);
        if (!r.created && r.mode === 'replace') L.push('- 注意：replace 已整篇重写，未传的节现在是「（待补）」');
        return { text: L.join('\n'), result: r };
      }
      throw new Error('action 只能是 save / list / get / update');
    },
  },
  {
    name: 'koujing_commit',
    description:
      '把确认过的一条规定写进对应的 AGENTS.md：自动挑小节、查重、备份、记台账，并跑 docs-lint。返回文件、小节、行号和 lint 结果。只用于长期生效的规定。',
    parameters: PARAMS.commit,
    isConcurrencySafe: () => false,
    run: async (args, exec) => {
      const r = commitRule({
        title: args?.title,
        body: args?.body,
        scope: args?.scope ?? 'user',
        wsPath: args?.wsPath,
        section: args?.section,
        tags: args?.tags,
        session: exec?.agent?.id,
      });
      if (r.status === 'duplicate') {
        return {
          text: `已存在近似规定，没有重复写入。\n${r.file}:${r.lines[0]}（## ${r.heading}）\n原文：${r.existing.text}\n如需修改，直接编辑该行或换一种说法重新提交。`,
          result: r,
        };
      }
      const lint = r.lint?.skipped ? `docs-lint：跳过（${r.lint.skipped}）` : r.lint?.ok ? 'docs-lint：通过' : `docs-lint：失败（exit ${r.lint?.code}）\n${r.lint?.tail ?? ''}`;
      return {
        text: [
          `已写入：${r.file}:${r.lines[0]}（## ${r.heading}）`,
          `备份：${r.backup ?? '（原文件不存在，未备份）'}`,
          lint,
          `台账：已登记 ${r.entry.id}`,
        ].join('\n'),
        result: r,
      };
    },
  },
  {
    name: 'koujing_search',
    description:
      '跨所有 AGENTS.md（用户级 + 各工作区）和插件台账按关键词检索规则原文，返回 path:line。回答“我之前是不是说过”或落地前先查重时用它，不靠记忆复述。',
    parameters: PARAMS.search,
    isConcurrencySafe: () => true,
    run: async (args) => {
      const hits = searchRules(args?.query, Math.max(1, Math.min(Number(args?.limit) || 20, 60)));
      if (!hits.length) return { text: `没有命中「${args?.query}」。可换更短的关键词，或用 koujing_ledger 看全部登记。`, hits };
      const L = [`命中 ${hits.length} 条：`];
      for (const h of hits) L.push(`${h.file}:${h.line}  ${h.heading ? `[${h.heading}] ` : ''}${h.text}`);
      return { text: L.join('\n'), hits };
    },
  },
  {
    name: 'koujing_ledger',
    description:
      '列出「口径」台账里登记过的规定：标题、落点、时间、来源会话，并标注这条在文件里还能不能找到（找不到=被手改或删了）。用来看清记住了什么。',
    parameters: PARAMS.ledger,
    isConcurrencySafe: () => true,
    run: async (args) => {
      const rows = ledgerReport();
      const list = args?.status === 'stale' ? rows.filter((r) => !r.found) : rows;
      if (!list.length) {
        return { text: args?.status === 'stale' ? '台账里没有失效条目。' : `台账还是空的。路径：${ledgerPath()}`, rows };
      }
      const L = [`台账 ${list.length} 条（${rows.filter((r) => r.found).length} 在文件里可找到）`];
      for (const r of list) {
        L.push(`${r.found ? '✓' : '✗'} ${r.id}  ${r.title}`);
        L.push(`    ${r.file}${r.line ? `:${r.line}` : ''}  ## ${r.heading}  ${r.at.slice(0, 10)}  ${r.scope}`);
      }
      return { text: L.join('\n'), rows: list };
    },
  },
  {
    name: 'koujing_timeline',
    description:
      '把以往记录串成时间线：读插件台账 D7 修改历史 / D8 报错记录、各工作区 PLAN、口径台账，按日期排出事件与主题线。events 只读列出，markdown 出全文，publish 写工作区 TIMELINE.md。回答“这些事是怎么一步步来的”时用它。',
    parameters: PARAMS.timeline,
    isConcurrencySafe: () => true,
    run: async (args, exec, ctx) => {
      const action = args?.action;
      if (action === 'publish') {
        const ws = workspaceOf(ctx, exec, args?.workspace);
        if (!ws) throw new Error('publish 需要 workspace');
        const r = publishTimeline(ws);
        return { text: `已刊登：${r.file}\n共 ${r.total} 条，范围 ${r.range.from ?? '—'} → ${r.range.to ?? '—'}`, result: r };
      }
      const tl = buildTimeline();
      if (action === 'markdown') return { text: renderTimelineMarkdown(tl), timeline: tl };
      const L = [`时间线 ${tl.total} 条（${tl.range.from ?? '—'} → ${tl.range.to ?? '—'}）`];
      for (const t of tl.threads) L.push(`\n【${t.name}】${t.count} 条 ${t.first} → ${t.last}`);
      L.push('');
      for (const e of tl.events) L.push(`${e.at}  ${e.kind === 'error' ? '⚠' : '·'} ${e.subject ? `${e.subject} · ` : ''}${e.title}`);
      return { text: L.join('\n'), timeline: tl };
    },
  },
];

export function apply(ctx) {
  const lang = pickLang(ctx);
  const sectionText = lang === 'en' ? POLICY_EN : POLICY_ZH;
  const reminderText = lang === 'en' ? REMIND_EN : REMIND_ZH;
  const reminderLabel = lang === 'en' ? 'Rule reminder' : '规则提醒';

  for (const def of TOOLS) {
    ctx.effect(() =>
      ctx.tools.register({
        name: def.name,
        description: def.description,
        parameters: def.parameters,
        output: OUTPUT,
        isConcurrencySafe: def.isConcurrencySafe,
        execute: async (args, exec) => {
          try {
            return await def.run(args ?? {}, exec, ctx);
          } catch (err) {
            return { text: `失败：${err?.message ?? err}` };
          }
        },
      }),
    );
  }

  // 提示词小节：极简 ctx（tool-audit / 只测工具的宿主）没有 systemPrompt，跳过而不是抛错。
  const sp = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : ctx.systemPrompt;
  if (sp && typeof sp.section === 'function') {
    ctx.effect(() =>
      sp.section({
        name: 'koujing:policy',
        order: sp.getSectionOrder('TEAM_POLICY'),
        text: sectionText,
      }),
    );
  }

  // 面板数据：只读路由，与页面同源；connection 存在时沿用它的准入判断。
  // 准入判断只留一处实现：台账与时间线都必须过它（timeline 曾漏加，2026-11-02 修）。
  const admit = (webCtx, req, res) => {
    const reject = webCtx.get('connection')?.requestRejection?.(req);
    if (reject === undefined) return true;
    res.statusCode = reject;
    res.end();
    return false;
  };
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
    try {
      webCtx.effect(() =>
        webCtx.webServer.register({
          kind: 'exact',
          path: '/koujing/ledger.json',
          handler: (req, res) => {
            try {
              if (!admit(webCtx, req, res)) return;
              const body = JSON.stringify({
                generatedAt: new Date().toISOString(),
                entries: ledgerReport(),
              });
              res.statusCode = 200;
              res.setHeader('content-type', 'application/json; charset=utf-8');
              res.setHeader('cache-control', 'no-store');
              res.end(body);
            } catch (err) {
              res.statusCode = 500;
              res.setHeader('content-type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ error: String(err?.message ?? err) }));
            }
          },
        }),
      );
    } catch (err) {
      ctx.logger?.warn?.(`koujing: ledger route not registered: ${err?.message ?? err}`);
    }
    });

    ctx.inject(['webServer'], (webCtx) => {
      try {
        webCtx.effect(() =>
          webCtx.webServer.register({
            kind: 'exact',
            path: '/koujing/timeline.json',
            handler: (req, res) => {
              try {
                if (!admit(webCtx, req, res)) return;
                const body = JSON.stringify(buildTimeline());
                res.statusCode = 200;
                res.setHeader('content-type', 'application/json; charset=utf-8');
                res.setHeader('cache-control', 'no-store');
                res.end(body);
              } catch (err) {
                res.statusCode = 500;
                res.setHeader('content-type', 'application/json; charset=utf-8');
                res.end(JSON.stringify({ error: String(err?.message ?? err) }));
              }
            },
          }),
        );
      } catch (err) {
        ctx.logger?.warn?.(`koujing: timeline route not registered: ${err?.message ?? err}`);
      }
    });
  }

  const reminded = new Map();
  if (typeof ctx.on === 'function') {
    ctx.on('agent/pre-step', async ({ agent, messages, turn }, next) => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;
    if (process.env.KOUJING_NO_REMIND === '1') return decision;
    const last = messages[messages.length - 1];
    const text = textOf(last).trim();
    if (!text || text.length > 600 || !looksLikeRule(text)) return decision;
    if (/[？?]\s*$/.test(text) && !/记住|记一下|记下来/.test(text)) return decision;
    const key = `${agent.id}|${turn}`;
    if (reminded.has(key)) return decision;
    reminded.set(key, 1);
    if (reminded.size > 300) reminded.delete(reminded.keys().next().value);
    const reminder = {
      role: 'user',
      id: crypto.randomUUID(),
      content: [{ type: 'text', text: reminderText }],
      source: { kind: 'koujing', form: 'notice', summary: reminderLabel },
    };
    return { ...decision, messages: [...decision.messages, reminder] };
    });
  }

  ctx.logger?.info?.('koujing: 6 tools + policy + pre-step reminder ready');
}
