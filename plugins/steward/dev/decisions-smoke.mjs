/**
 * 决策票据 v1.3 夹具（SPEC §8 夹具 1–25；24/25 = 关闭闸门：save/update/close 三处；26–30 = §13 受控写四动作；31 = 工具面返回值可无损序列化）。
 * 用法：node dev/decisions-smoke.mjs
 *
 * 隔离 HOME + 临时工作区，不碰真实 ~/.dsh；夹具 1 例外：只读扫真实在册计划（断言票据相关 issue = 0）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.join(HERE, '.home-dec');
const WS = path.join(HERE, '.ws-dec');
const DSH = path.join(HOME, '.dsh');

fs.rmSync(HOME, { recursive: true, force: true });
fs.rmSync(WS, { recursive: true, force: true });
fs.mkdirSync(path.join(DSH, 'storages'), { recursive: true });
fs.mkdirSync(WS, { recursive: true });
fs.writeFileSync(path.join(DSH, 'storages', 'workspace.json'), JSON.stringify({ tables: { workspaces: { a: { path: WS, title: 'dec-ws' } } } }), 'utf8');
process.env.KOUJING_HOME = HOME;
process.env.KOUJING_ISOLATED = '1';

const plan = await import('../lib/plan.js');
const P = await import('../lib/project.js');
const { parseDecisions, renderDecisions } = plan;

// 工具面（夹具 24/25 要断言「异常被压成文本后仍可读」）：最小 ctx 只注册工具，不接路由/事件
const idx = await import('../index.js');
const registered = new Map();
idx.apply({
  config: {},
  effect: (fn) => fn(),
  tools: { register: (def) => { registered.set(def.name, def); return () => {}; } },
  logger: {},
  get: () => undefined,
});
const callTool = (name, args) => registered.get(name).execute(args, {});
const attempt = (fn) => {
  try {
    return { ok: fn() };
  } catch (e) {
    return { err: e };
  }
};

const out = [];
const ok = (name, cond, extra = '') => out.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const codes = (issues) => issues.map((i) => i.code);
const exactCodes = (issues, expected) => eq([...codes(issues)].sort(), [...expected].sort());

const ticket = (id, title, fields = {}) => {
  const lines = [`### ${id}${title ? ` ${title}` : ''}`];
  for (const [k, v] of Object.entries(fields)) lines.push(`- ${k}: ${v}`);
  return lines.join('\n');
};
const block = (...tickets) => tickets.join('\n\n');

const save = (title, decisions, extra = {}) =>
  plan.savePlan({
    workspace: WS,
    title,
    goal: 'g',
    scope: '- 做：x',
    steps: ['甲', '乙', '丙'],
    accept: 'a',
    risks: 'r',
    decisions,
    ...extra,
  });

const readPlan = (title) => plan.getPlan(path.join(WS, `PLAN-${title}.md`));

// 1 无该节（live registry）：票据相关 issue = 0，fail ≤ 基线 6
{
  const dirs = ['D:\\dsh', 'C:\\Users\\Administrator\\Documents\\deepseek-harness\\default-workspace'].filter((d) => fs.existsSync(d));
  const files = dirs.flatMap((d) => plan.planFiles(d));
  let decIssues = 0;
  let fails = 0;
  for (const f of files) {
    const a = plan.auditPlanText(fs.readFileSync(f, 'utf8'));
    decIssues += a.issues.filter((i) => String(i.code ?? '').startsWith('DEC_')).length;
    fails += a.issues.filter((i) => i.level === 'fail').length;
  }
  ok('1 在册计划无票据节 → 票据 issue 0 且 fail ≤ 6', files.length > 0 && decIssues === 0 && fails <= 6, `${files.length} 份 / fail ${fails}`);
}

// 2 节存在但无票
{
  save('dec-empty', '');
  const p = readPlan('dec-empty').parsed;
  ok(
    '2 空节：decisions 存在、计数全 0、无 issue',
    p.decisions && p.decisions.tickets.length === 0 && p.decisions.frontier.length === 0 && p.decisions.issues.length === 0,
    JSON.stringify({ front: p.decisions?.frontier, issues: p.decisions?.issues }),
  );
  const raw = fs.readFileSync(path.join(WS, 'PLAN-dec-empty.md'), 'utf8');
  ok('2b 空节不写「（待补）」', /## 决策票据\n\n## 步骤/.test(raw) && !/决策票据[\s\S]*?（待补）/.test(raw.split('## 步骤')[0]), JSON.stringify(raw.split('\n').slice(0, 14)));
}

// 3 单票 open：check 级 warn DEC_PENDING 恰好 1 条；frontier 精确
{
  save('dec-open', block(ticket('T-01', '单票', { type: 'research', status: 'open', question: 'q' })));
  const a = plan.auditPlanText(fs.readFileSync(path.join(WS, 'PLAN-dec-open.md'), 'utf8'));
  const pending = a.issues.filter((i) => i.code === 'DEC_PENDING');
  ok('3 单票 open → check 恰 1 条 DEC_PENDING（ticket=null）', pending.length === 1 && pending[0].ticket === null, JSON.stringify(pending));
  ok('3b frontier 精确为 [T-01]', eq(readPlan('dec-open').parsed.decisions.frontier, ['T-01']), JSON.stringify(readPlan('dec-open').parsed.decisions.frontier));
}

// 4 单票 resolved
{
  const d = parseDecisions(block(ticket('T-01', '已决', { type: 'research', status: 'resolved', question: 'q', resolution: 'ok', resolved_at: '2026-11-07 01:00' })));
  ok('4 resolved 有 resolution → 无 issue、frontier 空', d.issues.length === 0 && d.frontier.length === 0, JSON.stringify(d.issues));
}

// 5 blocked_by 已 resolved → 进前沿
{
  const d = parseDecisions(
    block(
      ticket('T-01', 'a', { type: 'task', status: 'open', question: 'q', blocked_by: '[T-02]' }),
      ticket('T-02', 'b', { type: 'task', status: 'resolved', question: 'q', resolution: 'ok', resolved_at: '2026-11-07 01:00' }),
    ),
  );
  ok('5 阻塞者已 resolved → T-01 进前沿', d.issues.length === 0 && eq(d.frontier, ['T-01']), JSON.stringify({ issues: d.issues, front: d.frontier }));
}

// 6 blocked_by 仍 open → 不进前沿
{
  const d = parseDecisions(
    block(
      ticket('T-01', 'a', { type: 'task', status: 'open', question: 'q', blocked_by: '[T-02]' }),
      ticket('T-02', 'b', { type: 'task', status: 'open', question: 'q' }),
    ),
  );
  ok('6 阻塞者仍 open → T-01 不进前沿', d.issues.length === 0 && !d.frontier.includes('T-01'), JSON.stringify({ issues: d.issues, front: d.frontier }));
}

// 7 互指 → 恰 1 条 DEC_CYCLE，无 SELF_BLOCK
{
  const d = parseDecisions(
    block(
      ticket('T-01', 'a', { type: 'task', status: 'open', question: 'q', blocked_by: '[T-02]' }),
      ticket('T-02', 'b', { type: 'task', status: 'open', question: 'q', blocked_by: '[T-01]' }),
    ),
  );
  ok('7 互指 → 恰 1 条 DEC_CYCLE（不报 SELF_BLOCK）', exactCodes(d.issues, ['DEC_CYCLE']) && d.issues[0].ticket === null, JSON.stringify(codes(d.issues)));
}

// 8 引用不存在
{
  const d = parseDecisions(block(ticket('T-01', 'a', { type: 'task', status: 'open', question: 'q', blocked_by: '[T-99]' })));
  ok('8 blocked_by 指向不存在 → DEC_REF_MISSING', exactCodes(d.issues, ['DEC_REF_MISSING']) && d.issues[0].ticket === 'T-01', JSON.stringify(codes(d.issues)));
}

// 9 自指 → 恰 1 条 SELF_BLOCK，无 CYCLE
{
  const d = parseDecisions(block(ticket('T-01', 'a', { type: 'task', status: 'open', question: 'q', blocked_by: '[T-01]' })));
  ok('9 自指 → 恰 1 条 DEC_SELF_BLOCK（无 CYCLE）', exactCodes(d.issues, ['DEC_SELF_BLOCK']), JSON.stringify(codes(d.issues)));
}

// 10 两个 T-01
{
  const d = parseDecisions(block(ticket('T-01', 'a', { type: 'task', status: 'open', question: 'q' }), ticket('T-01', 'b', { type: 'task', status: 'open', question: 'q' })));
  ok('10 重复 ID → 恰 1 条 DEC_DUP_ID', exactCodes(d.issues, ['DEC_DUP_ID']) && d.issues[0].ticket === 'T-01', JSON.stringify(codes(d.issues)));
}

// 11 resolved 缺 resolution（给 resolved_at）→ 无 TIME_MISSING
{
  const d = parseDecisions(block(ticket('T-01', 'a', { type: 'task', status: 'resolved', question: 'q', resolved_at: '2026-11-07 01:00' })));
  ok('11 resolved 缺 resolution → RESOLUTION_MISSING 且无 TIME_MISSING', exactCodes(d.issues, ['DEC_RESOLUTION_MISSING']), JSON.stringify(codes(d.issues)));
}

// 12 claimed 缺 claimed_by（给 claimed_at）
{
  const d = parseDecisions(block(ticket('T-01', 'a', { type: 'task', status: 'claimed', question: 'q', claimed_at: '2026-11-07 01:00' })));
  ok('12 claimed 缺 claimed_by → CLAIM_NO_OWNER 且无 TIME_MISSING', exactCodes(d.issues, ['DEC_CLAIM_NO_OWNER']), JSON.stringify(codes(d.issues)));
}

// 13 type 乱写
{
  const d = parseDecisions(block(ticket('T-01', 'a', { type: '乱写', status: 'open', question: 'q' })));
  ok('13 type 非法 → DEC_STATUS', exactCodes(d.issues, ['DEC_STATUS']) && d.issues[0].field === 'type', JSON.stringify(d.issues));
}

// 14 缺 question
{
  const d = parseDecisions(block(ticket('T-01', 'a', { type: 'task', status: 'open' })));
  ok('14 缺 question → FIELD_MISSING（field=question）', exactCodes(d.issues, ['DEC_FIELD_MISSING']) && d.issues[0].field === 'question', JSON.stringify(d.issues));
}

// 15 open + 残留 resolution
{
  const d = parseDecisions(block(ticket('T-01', 'a', { type: 'task', status: 'open', question: 'q', resolution: '旧决议' })));
  ok('15 open 但残留 resolution → DEC_REOPENED', exactCodes(d.issues, ['DEC_REOPENED']), JSON.stringify(codes(d.issues)));
}

// 16 claimed 缺 claimed_at；resolved 缺 resolved_at
{
  const d = parseDecisions(
    block(
      ticket('T-01', 'a', { type: 'task', status: 'claimed', question: 'q', claimed_by: 'lead' }),
      ticket('T-02', 'b', { type: 'task', status: 'resolved', question: 'q', resolution: 'ok' }),
    ),
  );
  const times = d.issues.filter((i) => i.code === 'DEC_TIME_MISSING');
  ok('16 缺时间戳 → DEC_TIME_MISSING 各 1 条', times.length === 2 && exactCodes(d.issues, ['DEC_TIME_MISSING', 'DEC_TIME_MISSING']), JSON.stringify(d.issues));
}

// 17 blocked_by 混合分隔 / 小写 / 重复
{
  const d = parseDecisions(
    block(
      ticket('T-01', 'a', { type: 'task', status: 'open', question: 'q', blocked_by: '[T-02, t-03，T-02]' }),
      ticket('T-02', 'b', { type: 'task', status: 'resolved', question: 'q', resolution: 'ok', resolved_at: '2026-11-07 01:00' }),
      ticket('T-03', 'c', { type: 'task', status: 'resolved', question: 'q', resolution: 'ok', resolved_at: '2026-11-07 01:00' }),
    ),
  );
  ok(
    '17 blocked_by 归一为 [T-02, T-03]，无重复/引用问题',
    d.issues.length === 0 && eq(d.tickets[0].blocked_by, ['T-02', 'T-03']) && eq(d.frontier, ['T-01']),
    JSON.stringify({ blocked: d.tickets[0].blocked_by, issues: d.issues, front: d.frontier }),
  );
}

// 18 未知字段 + 重复字段（函数级渲染 + 工具级 issue 各 1 条）
{
  const text = '### T-01 a\n- type: task\n- status: open\n- question: q1\n- owner: me\n- question: q2';
  const d = parseDecisions(text);
  const rendered = renderDecisions(d.tickets);
  const idxQuestion = rendered.indexOf('- question: q2');
  const idxOwner = rendered.indexOf('- owner: me');
  ok('18 未知字段排在已知字段之后（首次出现序）', idxQuestion > 0 && idxOwner > idxQuestion && rendered.includes('- question: q2') && !rendered.includes('q1'), rendered.replace(/\n/g, ' | '));
  ok('18b 未知 / 重复字段各 1 条 warn', exactCodes(d.issues, ['DEC_DUP_FIELD', 'DEC_UNKNOWN_FIELD']), JSON.stringify(codes(d.issues)));
}

// 19 票块内自由文本 / #### 备注 → 字节 round-trip
{
  const text = block('- type: task\n- status: open\n- question: q\n\n自由文本行\n#### 备注\n备注内容'.replace(/^/, '### T-01 标题\n'));
  const d = parseDecisions(text);
  const rendered = renderDecisions(d.tickets);
  ok('19 自由文本 / 备注 round-trip 字节相同', rendered === text, JSON.stringify({ rendered, text }));
  ok('19b body 与输入一致', d.tickets[0].body === '自由文本行\n#### 备注\n备注内容', JSON.stringify(d.tickets[0].body));
}

// 20 字段值含冒号
{
  const d = parseDecisions(block(ticket('T-01', 'a', { type: 'task', status: 'resolved', question: '用 A: 还是 B', resolution: '选 A', resolved_at: '2026-11-07 01:50' })));
  ok('20 按第一个冒号切分', d.issues.length === 0 && d.tickets[0].question === '用 A: 还是 B' && d.tickets[0].resolved_at === '2026-11-07 01:50', JSON.stringify(d.tickets[0]));
}

// 21 CRLF + BOM 文件：票据与 body 解析正确
{
  const raw = [
    '\uFEFF---', 'title: dec-bom', 'status: active', 'created: 2026-11-07', '---', '', '# dec-bom', '',
    '## 目标', '', 'g', '', '## 范围', '', '- 做：x', '',
    '## 决策票据', '', '### T-01 标题', '- type: task', '- status: open', '- question: q', '', 'body 行', '',
    '## 步骤', '', '- [ ] 1. 甲 [High] [自做]', '- [ ] 2. 乙 [High] [自做]', '- [ ] 3. 丙 [High] [自做]', '',
    '## 验收', '', 'a', '', '## 风险 / 回滚', '', 'r', '', '## 进度记录', '', '- 2026-11-07 建立', '',
  ].join('\r\n');
  const file = path.join(WS, 'PLAN-dec-bom.md');
  fs.writeFileSync(file, raw, 'utf8');
  const p = plan.getPlan(file).parsed;
  ok(
    '21 BOM+CRLF：票据与 body 解析正确（frontmatter 不再丢）',
    p.decisions?.tickets?.[0]?.id === 'T-01' && p.decisions.tickets[0].body === 'body 行' && p.status === 'active',
    JSON.stringify({ status: p.status, body: p.decisions?.tickets?.[0]?.body }),
  );
}

// 22 save(decisions) → get → save(merge) 不重复节、ID 不重排、body 不丢；merge 不传语义不变
{
  const text = block(ticket('T-01', 'a', { type: 'task', status: 'resolved', question: 'q', resolution: 'ok', resolved_at: '2026-11-07 01:00' }), ticket('T-02', 'b', { type: 'task', status: 'open', question: 'q2' }));
  save('dec-round', text);
  const p1 = readPlan('dec-round');
  save('dec-round', renderDecisions(p1.parsed.decisions.tickets), { mode: 'merge' });
  const raw2 = fs.readFileSync(path.join(WS, 'PLAN-dec-round.md'), 'utf8');
  const p2 = plan.getPlan(path.join(WS, 'PLAN-dec-round.md')).parsed;
  ok(
    '22 save→get→save 不重复节、ID 顺序不变',
    (raw2.match(/^## 决策票据$/gm) ?? []).length === 1 && eq(p2.decisions.tickets.map((t) => t.id), ['T-01', 'T-02']),
    JSON.stringify({ sections: (raw2.match(/^## 决策票据$/gm) ?? []).length, ids: p2.decisions.tickets.map((t) => t.id) }),
  );
  const before = JSON.stringify(p2.decisions.tickets);
  save('dec-round', undefined, { mode: 'merge' });
  const after = plan.getPlan(path.join(WS, 'PLAN-dec-round.md')).parsed.decisions;
  ok('22b merge 不传 → 旧节语义不变', JSON.stringify(after.tickets) === before, JSON.stringify(after.tickets.map((t) => t.id)));
}

// 23 删 / 空 / append 边界
{
  save('dec-del', block(ticket('T-01', 'a', { type: 'task', status: 'open', question: 'q' })));
  save('dec-del', undefined, { mode: 'replace' });
  ok('23.1 replace 不传 → 节删除', !fs.readFileSync(path.join(WS, 'PLAN-dec-del.md'), 'utf8').includes('## 决策票据'));

  save('dec-del2', block(ticket('T-01', 'a', { type: 'task', status: 'open', question: 'q' })));
  save('dec-del2', '', { mode: 'replace' });
  const rawEmpty = fs.readFileSync(path.join(WS, 'PLAN-dec-del2.md'), 'utf8');
  ok('23.2 replace 传空串 → 空节、无「（待补）」', /## 决策票据\n\n## 步骤/.test(rawEmpty) && !rawEmpty.includes('决策票据\n\n（待补）'), rawEmpty.split('\n').slice(10, 16).join(' | '));

  save('dec-del3', block(ticket('T-01', 'a', { type: 'task', status: 'open', question: 'q' })));
  save('dec-del3', '', { mode: 'merge' });
  ok('23.3 merge 传空串 → 空节', !plan.getPlan(path.join(WS, 'PLAN-dec-del3.md')).parsed.decisions.tickets.length);

  save('dec-app0', '', { mode: 'append' });
  ok('23.4 append 空串且无旧节 → 不新增节', !fs.readFileSync(path.join(WS, 'PLAN-dec-app0.md'), 'utf8').includes('## 决策票据'));

  save('dec-app1', block(ticket('T-01', 'a', { type: 'task', status: 'open', question: 'q' })));
  save('dec-app1', undefined, { mode: 'append' });
  ok('23.5 append 不传 → 旧节不变', plan.getPlan(path.join(WS, 'PLAN-dec-app1.md')).parsed.decisions.tickets.length === 1);

  save('dec-app2', block(ticket('T-01', 'a', { type: 'task', status: 'open', question: 'q' })));
  const fileApp = path.join(WS, 'PLAN-dec-app2.md');
  const beforeBytes = fs.readFileSync(fileApp, 'utf8');
  let err = null;
  try {
    save('dec-app2', block(ticket('T-01', 'dup', { type: 'task', status: 'open', question: 'q' })), { mode: 'append' });
  } catch (e) {
    err = e;
  }
  ok('23.6 append 撞既有 ID → 抛 DEC_DUP_ID 且文件不写', err?.code === 'DEC_DUP_ID' && fs.readFileSync(fileApp, 'utf8') === beforeBytes, err ? `${err.code} ${err.message}` : '没有抛错');
}

// ---------------------------------------------------------------- 24 save status=done（关闭闸门）
{
  const title = 'dec-gate-save';
  save(title, block(ticket('T-01', '待决', { type: 'task', status: 'open', question: 'q' })));
  const file = path.join(WS, `PLAN-${title}.md`);
  const before = fs.readFileSync(file, 'utf8');
  const unchanged = () => fs.readFileSync(file, 'utf8') === before;

  // 24.1 merge + 不传：旧票仍在 → DEC_PENDING
  const e1 = attempt(() => save(title, undefined, { status: 'done' })).err;
  ok(
    '24.1 save done + merge 不传（旧票仍在）→ DEC_PENDING、文件字节未变',
    e1?.code === 'DEC_PENDING' && String(e1.message).includes('DEC_PENDING') && (e1.tickets ?? []).includes('T-01') && unchanged(),
    e1 ? `${e1.code} tickets=${JSON.stringify(e1.tickets)}` : '没有抛错',
  );

  // 24.2 replace + 不传：旧票随节消失 → DEC_PENDING
  const e2 = attempt(() => save(title, undefined, { mode: 'replace', status: 'done' })).err;
  ok(
    '24.2 save done + replace 不传（旧票消失）→ DEC_PENDING、文件字节未变',
    e2?.code === 'DEC_PENDING' && (e2.tickets ?? []).includes('T-01') && unchanged(),
    e2 ? `${e2.code} tickets=${JSON.stringify(e2.tickets)}` : '没有抛错',
  );

  // 24.3 merge + decisions 空串：旧票随节清空 → DEC_PENDING
  const e3 = attempt(() => save(title, '', { status: 'done' })).err;
  ok(
    '24.3 save done + decisions 空串（旧票消失）→ DEC_PENDING、文件字节未变',
    e3?.code === 'DEC_PENDING' && (e3.tickets ?? []).includes('T-01') && unchanged(),
    e3 ? `${e3.code} tickets=${JSON.stringify(e3.tickets)}` : '没有抛错',
  );

  // 24.4 同一次 save 把未决票改成终态 → 放行（A6）
  const okDone = attempt(() =>
    save(title, block(ticket('T-01', '已决', { type: 'task', status: 'resolved', question: 'q', resolution: 'ok', resolved_at: '2026-11-07 05:00' })), { status: 'done' }),
  ).err;
  ok(
    '24.4 同一次 save 把未决改 resolved → 放行、status=done',
    okDone === undefined && /status: done/.test(fs.readFileSync(file, 'utf8')),
    okDone ? `${okDone.code} ${okDone.message}` : '',
  );

  // 24.5 工具层：新建 done 计划带未决票 → 文本含 DEC_PENDING，文件不创建
  const r = await callTool('steward_plan', {
    action: 'save',
    workspace: WS,
    title: 'dec-gate-tool',
    status: 'done',
    decisions: block(ticket('T-01', '待决', { type: 'task', status: 'open', question: 'q' })),
  });
  ok(
    '24.5 工具层 save done 返回文本含 DEC_PENDING 且文件未创建',
    String(r.text).includes('DEC_PENDING') && !fs.existsSync(path.join(WS, 'PLAN-dec-gate-tool.md')),
    String(r.text).slice(0, 120),
  );
}

// ---------------------------------------------------------------- 25 关闭：update done / handoff close + 三类放行
{
  const title = 'dec-gate-close';
  save(title, block(ticket('T-01', '待决', { type: 'task', status: 'open', question: 'q' })));
  const planFile = path.join(WS, `PLAN-${title}.md`);
  const before = fs.readFileSync(planFile, 'utf8');

  // 25.1 update status=done（工具层）：文本含 DEC_PENDING，文件字节未变
  const r1 = await callTool('steward_plan', { action: 'update', plan: planFile, status: 'done' });
  ok(
    '25.1 update done 工具层文本含 DEC_PENDING、文件字节未变',
    String(r1.text).includes('DEC_PENDING') && fs.readFileSync(planFile, 'utf8') === before,
    String(r1.text).slice(0, 120),
  );

  // 25.2 handoff close：有未决票 → 抛 DEC_PENDING；HANDOFF / STATUS 都未创建，项目仍 active
  const handoffDir = path.join(WS, 'dec-handoff');
  const statusFile = path.join(WS, 'S-dec-gate.md');
  P.registerProject({ key: 'dec-gate', title: '决策闸门', source: WS, statusFile, handoffDir, plan: planFile });
  const a = attempt(() => P.closeProject('dec-gate'));
  const handoffFiles = fs.existsSync(handoffDir) ? fs.readdirSync(handoffDir) : [];
  ok(
    '25.2 close 有未决票 → DEC_PENDING、HANDOFF/STATUS 未创建、项目仍 active',
    a.err?.code === 'DEC_PENDING' &&
      (a.err.tickets ?? []).includes('T-01') &&
      handoffFiles.length === 0 &&
      !fs.existsSync(statusFile) &&
      P.getProject('dec-gate').status === 'active',
    a.err ? a.err.code : '没有抛错',
  );

  // 25.3 工具层 handoff close 同样拦：文本含 DEC_PENDING、HANDOFF 未创建
  save('dec-gate-close2', block(ticket('T-01', '待决', { type: 'task', status: 'open', question: 'q' })));
  const handoffDir2 = path.join(WS, 'dec-handoff2');
  P.registerProject({
    key: 'dec-gate2',
    title: '决策闸门2',
    source: WS,
    statusFile: path.join(WS, 'S-dec-gate2.md'),
    handoffDir: handoffDir2,
    plan: path.join(WS, 'PLAN-dec-gate-close2.md'),
  });
  const r2 = await callTool('steward_handoff', { action: 'close', key: 'dec-gate2' });
  ok(
    '25.3 工具层 handoff close 文本含 DEC_PENDING、HANDOFF 未创建',
    String(r2.text).includes('DEC_PENDING') && (fs.existsSync(handoffDir2) ? fs.readdirSync(handoffDir2).length : 0) === 0,
    String(r2.text).slice(0, 120),
  );

  // 25.4 planDone=false：不拦，issues 一条 warn，文本有 [warn]
  const r3 = await callTool('steward_handoff', { action: 'close', key: 'dec-gate', planDone: false });
  ok(
    '25.4 planDone=false → 不拦，issues 1 条 warn 且文本有 [warn]',
    r3.result?.issues?.length === 1 &&
      r3.result.issues[0].msg.includes('planDone=false') &&
      String(r3.text).includes('[warn]') &&
      fs.existsSync(r3.result.handoff),
    JSON.stringify(r3.result?.issues),
  );

  // 25.5 项目无 plan：不拦，warn「没有可审计的计划」
  P.registerProject({
    key: 'dec-noplan',
    title: '无计划项目',
    source: WS,
    statusFile: path.join(WS, 'S-dec-noplan.md'),
    handoffDir: path.join(WS, 'dec-handoff-noplan'),
  });
  const r4 = P.closeProject('dec-noplan');
  ok(
    '25.5 项目无 plan → 不拦，warn「没有可审计的计划」',
    r4.issues?.length === 1 && r4.issues[0].msg.includes('没有可审计的计划'),
    JSON.stringify(r4.issues),
  );

  // 25.6 计划读不到：不拦，warn「计划读不到」（plan 指向目录 → readFileSync EISDIR）
  const dirPlan = path.join(WS, 'PLAN-dir.md');
  fs.mkdirSync(dirPlan, { recursive: true });
  P.registerProject({
    key: 'dec-badplan',
    title: '坏计划项目',
    source: WS,
    statusFile: path.join(WS, 'S-dec-bad.md'),
    handoffDir: path.join(WS, 'dec-handoff-bad'),
    plan: dirPlan,
  });
  const r5 = P.closeProject('dec-badplan');
  ok(
    '25.6 计划读不到 → 不拦，warn「计划读不到」',
    r5.issues?.length === 1 && r5.issues[0].msg.includes('计划读不到'),
    JSON.stringify(r5.issues),
  );
}

// ---------------------------------------------------------------- 26–30 受控写（SPEC §13，v1.3）
{
  // 26 init：建节 / 幂等 / done 计划拒写
  save('dec-init', undefined);
  const f = path.join(WS, 'PLAN-dec-init.md');
  ok('26.0 前置：还没有决策票据节', !fs.readFileSync(f, 'utf8').includes('## 决策票据'));
  const r1 = plan.initDecisions(f);
  const raw1 = fs.readFileSync(f, 'utf8');
  ok(
    '26.1 init 建空节 + created=true',
    r1.created === true && (raw1.match(/^## 决策票据$/gm) ?? []).length === 1 && plan.getPlan(f).parsed.decisions.tickets.length === 0,
    JSON.stringify({ created: r1.created, sections: (raw1.match(/^## 决策票据$/gm) ?? []).length }),
  );
  const r2 = plan.initDecisions(f);
  ok('26.2 init 幂等：不重复建节、created=false', r2.created === false && (fs.readFileSync(f, 'utf8').match(/^## 决策票据$/gm) ?? []).length === 1);

  save('dec-init-done', undefined, { status: 'done' });
  const fdone = path.join(WS, 'PLAN-dec-init-done.md');
  const doneBefore = fs.readFileSync(fdone, 'utf8');
  const e0 = attempt(() => plan.initDecisions(fdone)).err;
  ok('26.3 done 计划 → DEC_READONLY、字节不变', e0?.code === 'DEC_READONLY' && fs.readFileSync(fdone, 'utf8') === doneBefore, e0?.code ?? '没有抛错');

  // 26.4 节已存在（手写非规范形态）→ init 不写盘、字节不变
  const rawHand = [
    '---', 'title: dec-init-hand', 'status: active', 'created: 2026-11-07', '---', '', '# dec-init-hand', '',
    '## 目标', '', 'g', '', '## 范围', '', '- 做：x', '',
    '## 决策票据', '', '### T-01 手写', '- status: open', '- type: task', '- question: q', '',
    '## 步骤', '', '- [ ] 1. 甲 [High] [自做]', '- [ ] 2. 乙 [High] [自做]', '- [ ] 3. 丙 [High] [自做]', '',
    '## 验收', '', 'a', '', '## 风险 / 回滚', '', 'r', '', '## 进度记录', '', '- 2026-11-07 建立', '',
  ].join('\n');
  const fhand = path.join(WS, 'PLAN-dec-init-hand.md');
  fs.writeFileSync(fhand, rawHand, 'utf8');
  const handBefore = fs.readFileSync(fhand, 'utf8');
  const rHand = plan.initDecisions(fhand);
  ok(
    '26.4 已存在（手写形态）→ init 幂等，不写盘、字节不变',
    rHand.created === false && rHand.changed === false && fs.readFileSync(fhand, 'utf8') === handBefore,
    JSON.stringify({ created: rHand.created, changed: rHand.changed }),
  );
}

{
  // 27 ticket：自动编号 / 归一化 / 重复 ID / 非法 ID / 缺字段 / 非法 type
  save('dec-ticket', undefined);
  const f = path.join(WS, 'PLAN-dec-ticket.md');
  const t1 = plan.addDecisionTicket(f, { title: '甲', type: 'research', question: 'q1' });
  const t2 = plan.addDecisionTicket(f, { title: '乙', type: 'task', question: 'q2', blocked_by: 't-01，T-01', links: 'a.md, b.md' });
  ok(
    '27.1 自动编号 T-01/T-02 且都是 open',
    t1.ticket.id === 'T-01' && t2.ticket.id === 'T-02' && t1.ticket.status === 'open' && t2.ticket.status === 'open',
    JSON.stringify([t1.ticket.id, t2.ticket.id]),
  );
  ok('27.2 blocked_by 归一化去重、links 落位', eq(t2.ticket.blocked_by, ['T-01']) && eq(t2.ticket.links, ['a.md', 'b.md']), JSON.stringify({ b: t2.ticket.blocked_by, l: t2.ticket.links }));
  const before = fs.readFileSync(f, 'utf8');
  const e1 = attempt(() => plan.addDecisionTicket(f, { id: 'T-01', title: '重', type: 'task', question: 'q' })).err;
  ok('27.3 显式重复 ID → DEC_DUP_ID、文件不变', e1?.code === 'DEC_DUP_ID' && fs.readFileSync(f, 'utf8') === before, e1?.code ?? '没有抛错');
  const e2 = attempt(() => plan.addDecisionTicket(f, { id: 'X-01', title: '坏号', type: 'task', question: 'q' })).err;
  ok('27.4 非法 ID → DEC_INVALID_ID、文件不变', e2?.code === 'DEC_INVALID_ID' && fs.readFileSync(f, 'utf8') === before, e2?.code ?? '没有抛错');
  const e3 = attempt(() => plan.addDecisionTicket(f, { title: '缺问题', type: 'task' })).err;
  ok('27.5 缺 question → DEC_FIELD_MISSING、文件不变', e3?.code === 'DEC_FIELD_MISSING' && fs.readFileSync(f, 'utf8') === before, e3?.code ?? '没有抛错');
  const e4 = attempt(() => plan.addDecisionTicket(f, { title: '坏类型', type: '乱写', question: 'q' })).err;
  ok('27.6 非法 type → DEC_STATUS、文件不变', e4?.code === 'DEC_STATUS' && fs.readFileSync(f, 'utf8') === before, e4?.code ?? '没有抛错');
  ok('27.7 其它节未被动作破坏（步骤仍 3 条）', plan.getPlan(f).parsed.steps.length === 3, String(plan.getPlan(f).parsed.steps.length));
  const e5 = attempt(() => plan.addDecisionTicket(f, { type: 'task', question: 'q' })).err;
  ok('27.8 缺 title → DEC_FIELD_MISSING、文件不变', e5?.code === 'DEC_FIELD_MISSING' && fs.readFileSync(f, 'utf8') === before, e5?.code ?? '没有抛错');
  const e6 = attempt(() => plan.addDecisionTicket(f, { title: '坏引用', type: 'task', question: 'q', blocked_by: 'T-99' })).err;
  ok('27.9 候选文本新增 DEC_REF_MISSING → 拒写、文件不变', e6?.code === 'DEC_REF_MISSING' && fs.readFileSync(f, 'utf8') === before, e6?.code ?? '没有抛错');
}

{
  // 28 claim：缺 by / 不存在 / 正常认领 / 重复 / 终态 / 工具层非原子文案
  save('dec-claim', undefined);
  const f = path.join(WS, 'PLAN-dec-claim.md');
  plan.addDecisionTicket(f, { title: '待认领', type: 'task', question: 'q' });
  const before = fs.readFileSync(f, 'utf8');
  const e1 = attempt(() => plan.claimDecision(f, 'T-01', '')).err;
  ok('28.1 claim 缺 by → DEC_FIELD_MISSING、文件不变', e1?.code === 'DEC_FIELD_MISSING' && fs.readFileSync(f, 'utf8') === before, e1?.code ?? '没有抛错');
  const e2 = attempt(() => plan.claimDecision(f, 'T-99', 'lead')).err;
  ok('28.2 票不存在 → DEC_NOT_FOUND', e2?.code === 'DEC_NOT_FOUND', e2?.code ?? '没有抛错');
  const r = plan.claimDecision(f, 'T-01', 'lead');
  ok(
    '28.3 claim → claimed + claimed_by + 本地时间格式',
    r.ticket.status === 'claimed' && r.ticket.claimed_by === 'lead' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(r.ticket.claimed_at),
    JSON.stringify({ status: r.ticket.status, at: r.ticket.claimed_at }),
  );
  const e3 = attempt(() => plan.claimDecision(f, 'T-01', 'other')).err;
  ok('28.4 重复 claim → DEC_STATE', e3?.code === 'DEC_STATE', e3?.code ?? '没有抛错');
  plan.resolveDecision(f, 'T-01', { resolution: '已决' });
  const e4 = attempt(() => plan.claimDecision(f, 'T-01', 'other')).err;
  ok('28.5 终态 claim → DEC_STATE', e4?.code === 'DEC_STATE', e4?.code ?? '没有抛错');

  save('dec-claim-tool', undefined);
  const ft = path.join(WS, 'PLAN-dec-claim-tool.md');
  const rInit = await callTool('steward_plan', { action: 'init', plan: ft });
  const rTicket = await callTool('steward_plan', { action: 'ticket', plan: ft, ticket_title: '工具票', type: 'task', question: 'q' });
  const rClaim = await callTool('steward_plan', { action: 'claim', plan: ft, id: 'T-01', by: 'lead' });
  ok(
    '28.6 工具层 init/ticket/claim 文本正确且带「不承诺独占」提示',
    String(rInit.text).includes('已初始化') && String(rTicket.text).includes('已新增票 T-01') && String(rClaim.text).includes('不承诺独占') && String(rClaim.text).includes('claimed_by=lead'),
    String(rClaim.text).split('\n')[0],
  );
}

{
  // 29 resolve：缺 resolution / 正常 / 重复 / out-of-scope / 不存在 / 收尾联动
  save('dec-resolve', undefined);
  const f = path.join(WS, 'PLAN-dec-resolve.md');
  plan.addDecisionTicket(f, { title: '甲', type: 'task', question: 'q1' });
  plan.addDecisionTicket(f, { title: '乙', type: 'task', question: 'q2' });
  const before = fs.readFileSync(f, 'utf8');
  const e1 = attempt(() => plan.resolveDecision(f, 'T-01', {})).err;
  ok('29.1 resolve 缺 resolution → DEC_RESOLUTION_MISSING、文件不变', e1?.code === 'DEC_RESOLUTION_MISSING' && fs.readFileSync(f, 'utf8') === before, e1?.code ?? '没有抛错');
  const r1 = plan.resolveDecision(f, 'T-01', { resolution: '选 A' });
  ok(
    '29.2 open→resolved + resolution + resolved_at',
    r1.ticket.status === 'resolved' && r1.ticket.resolution === '选 A' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(r1.ticket.resolved_at),
    JSON.stringify({ status: r1.ticket.status, at: r1.ticket.resolved_at }),
  );
  const e2 = attempt(() => plan.resolveDecision(f, 'T-01', { resolution: '再来' })).err;
  ok('29.3 重复 resolve → DEC_STATE', e2?.code === 'DEC_STATE', e2?.code ?? '没有抛错');
  const r2 = plan.resolveDecision(f, 'T-02', { resolution: '不做', status: 'out-of-scope' });
  ok('29.4 out-of-scope 终态', r2.ticket.status === 'out-of-scope' && r2.ticket.resolution === '不做', r2.ticket.status);
  const e3 = attempt(() => plan.resolveDecision(f, 'T-99', { resolution: 'x' })).err;
  ok('29.5 票不存在 → DEC_NOT_FOUND', e3?.code === 'DEC_NOT_FOUND', e3?.code ?? '没有抛错');
  const done = plan.updatePlan({ ref: f, status: 'done' });
  ok('29.6 票全部终态后 update status=done 放行（闸门联动）', done.status === 'done', done.status);
}

{
  // 30 老 fail 不锁死整节 / done 计划工具层拒写 / resolve 工具层
  save('dec-legacy', block(ticket('T-01', '旧脏票', { type: 'task', status: 'open' }))); // 缺 question = 老 fail
  const f = path.join(WS, 'PLAN-dec-legacy.md');
  const okAdd = attempt(() => plan.addDecisionTicket(f, { title: '新票', type: 'task', question: 'q' })).err;
  const after = plan.getPlan(f).parsed.decisions;
  ok(
    '30.1 旧票已有 fail 不挡新票（只拒本次新增的 fail）',
    okAdd === undefined && after.tickets.length === 2 && after.issues.some((i) => i.code === 'DEC_FIELD_MISSING' && i.ticket === 'T-01'),
    JSON.stringify(after.issues.map((i) => `${i.code}:${i.ticket}`)),
  );

  save('dec-tool-resolve', undefined);
  const ft = path.join(WS, 'PLAN-dec-tool-resolve.md');
  await callTool('steward_plan', { action: 'init', plan: ft });
  await callTool('steward_plan', { action: 'ticket', plan: ft, ticket_title: '工具票', type: 'task', question: 'q' });
  const rr = await callTool('steward_plan', { action: 'resolve', plan: ft, id: 'T-01', resolution: 'ok' });
  ok(
    '30.2 工具层 resolve 文本含 status=resolved 与非原子提示',
    String(rr.text).includes('已决 T-01') && String(rr.text).includes('status=resolved') && String(rr.text).includes('非原子'),
    String(rr.text).split('\n')[0],
  );

  const bad = await callTool('steward_plan', { action: 'init', plan: path.join(WS, 'PLAN-dec-init-done.md') });
  ok('30.3 done 计划工具层 → 文本含 DEC_READONLY', String(bad.text).includes('DEC_READONLY'), String(bad.text).slice(0, 80));

  // 30.4 决策票据节里的代码围栏：### 示例不算票头（SPEC §9）
  const fenceText =
    ticket('T-01', '真票', { type: 'task', status: 'open', question: 'q' }) +
    '\n\n' +
    '```text\n### T-02 示例\n- type: research\n- status: open\n- question: 示例\n```';
  const dFence = plan.parseDecisions(fenceText);
  ok(
    '30.4 围栏里的 ### 不算票头、围栏行进 body（无 phantom 票）',
    dFence.tickets.length === 1 && dFence.tickets[0].id === 'T-01' && dFence.tickets[0].body.includes('### T-02 示例') && dFence.issues.length === 0,
    JSON.stringify({ ids: dFence.tickets.map((t) => t.id), issues: dFence.issues.map((i) => i.code) }),
  );

  // 30.5 非 PLAN-*.md 路径拒写（P1-2 回归）
  const notPlan = path.join(WS, 'NOT-A-PLAN.md');
  fs.writeFileSync(notPlan, '# 不是计划\n', 'utf8');
  const npBefore = fs.readFileSync(notPlan, 'utf8');
  const eNp = attempt(() => plan.initDecisions(notPlan)).err;
  ok('30.5 非 PLAN-*.md → DEC_NOT_PLAN、字节不变', eNp?.code === 'DEC_NOT_PLAN' && fs.readFileSync(notPlan, 'utf8') === npBefore, eNp?.code ?? '没有抛错');

  // 30.6 节外内容零丢失（P1-1 回归）：节前说明 / 步骤节说明段 / 围栏都保留
  const rawPreserve = [
    '---', 'title: dec-preserve', 'status: active', 'created: 2026-11-07', 'updated: 2026-11-07', '---', '', '# dec-preserve', '',
    '> 节前说明：这行不能被动作吃掉。', '',
    '## 目标', '', 'g', '',
    '## 范围', '', '- 做：x', '',
    '## 步骤', '', '说明段：这行也不能丢。', '', '```text', '代码围栏里的 ## 不是节', '```', '',
    '- [ ] 1. 甲 [High] [自做]', '- [ ] 2. 乙 [High] [自做]', '- [ ] 3. 丙 [High] [自做]', '',
    '## 验收', '', 'a', '',
    '## 风险 / 回滚', '', 'r', '',
    '## 进度记录', '', '- 2026-11-07 建立', '',
  ].join('\n');
  const fPreserve = path.join(WS, 'PLAN-dec-preserve.md');
  fs.writeFileSync(fPreserve, rawPreserve, 'utf8');
  const rPreserve = plan.addDecisionTicket(fPreserve, { title: '新票', type: 'task', question: 'q' });
  const preserved = fs.readFileSync(fPreserve, 'utf8');
  ok(
    '30.6 只换决策票据节：节前说明 / 步骤说明段 / 步骤围栏全部保留',
    rPreserve.changed === true &&
      preserved.includes('> 节前说明：这行不能被动作吃掉。') &&
      preserved.includes('说明段：这行也不能丢。') &&
      preserved.includes('代码围栏里的 ## 不是节') &&
      plan.getPlan(fPreserve).parsed.steps.length === 3 &&
      preserved.includes('### T-01 新票'),
    JSON.stringify({ bytes: preserved.length, steps: plan.getPlan(fPreserve).parsed.steps.length }),
  );

  // 30.7 CRLF + BOM：动作保留编码形态
  const rawCrlf = '\uFEFF' + [
    '---', 'title: dec-crlf', 'status: active', 'created: 2026-11-07', '---', '', '# dec-crlf', '',
    '## 目标', '', 'g', '', '## 范围', '', '- 做：x', '',
    '## 步骤', '', '- [ ] 1. 甲 [High] [自做]', '- [ ] 2. 乙 [High] [自做]', '- [ ] 3. 丙 [High] [自做]', '',
    '## 验收', '', 'a', '', '## 风险 / 回滚', '', 'r', '', '## 进度记录', '', '- 2026-11-07 建立', '',
  ].join('\r\n');
  const fCrlf = path.join(WS, 'PLAN-dec-crlf.md');
  fs.writeFileSync(fCrlf, rawCrlf, 'utf8');
  plan.addDecisionTicket(fCrlf, { title: 'CRLF 票', type: 'task', question: 'q' });
  const crlfText = fs.readFileSync(fCrlf, 'utf8');
  ok(
    '30.7 CRLF+BOM 计划：BOM 保留、全文仍 CRLF、票已写入',
    crlfText.startsWith('\uFEFF') && !/(^|[^\r])\n/.test(crlfText) && crlfText.includes('### T-01 CRLF 票'),
    JSON.stringify({ bom: crlfText.startsWith('\uFEFF'), lfOnly: /(^|[^\r])\n/.test(crlfText) }),
  );

  // 30.8 节外 EOF 空白不被归一（P2-1 回归）：中间节改写，文件末尾多空行原样
  const rawEof = [
    '---', 'title: dec-eof', 'status: active', 'created: 2026-11-07', 'updated: 2026-11-07', '---', '', '# dec-eof', '',
    '## 目标', '', 'g', '',
    '## 范围', '', '- 做：x', '',
    '## 决策票据', '', '### T-01 旧票', '- type: task', '- status: open', '- question: q', '',
    '## 步骤', '', '- [ ] 1. 甲 [High] [自做]', '- [ ] 2. 乙 [High] [自做]', '- [ ] 3. 丙 [High] [自做]', '',
    '## 验收', '', 'a', '', '## 风险 / 回滚', '', 'r', '', '## 进度记录', '', '- 2026-11-07 建立', '', '', '',
  ].join('\n');
  const fEof = path.join(WS, 'PLAN-dec-eof.md');
  fs.writeFileSync(fEof, rawEof, 'utf8');
  const eofTail = (rawEof.match(/\s*$/) ?? [''])[0];
  plan.addDecisionTicket(fEof, { title: 'EOF 票', type: 'task', question: 'q' });
  const eofText = fs.readFileSync(fEof, 'utf8');
  ok(
    '30.8 节外 EOF 空白不变（中间节改写不归一文件末尾）',
    (eofText.match(/\s*$/) ?? [''])[0] === eofTail && eofText.includes('### T-02 EOF 票') && plan.getPlan(fEof).parsed.steps.length === 3,
    JSON.stringify({ tailBefore: eofTail.length, tailAfter: (eofText.match(/\s*$/) ?? [''])[0].length }),
  );

  // 30.9 混合 EOL：frontmatter 的 LF 不被正文 CRLF 带偏（P2-2 回归）
  const mixedHead = '---\ntitle: dec-mixed\nstatus: active\ncreated: 2026-11-07\nupdated: 2026-11-07\n---\n';
  const mixedBody = [
    '# dec-mixed', '',
    '## 目标', '', 'g', '', '## 范围', '', '- 做：x', '',
    '## 步骤', '', '- [ ] 1. 甲 [High] [自做]', '- [ ] 2. 乙 [High] [自做]', '- [ ] 3. 丙 [High] [自做]', '',
    '## 验收', '', 'a', '', '## 风险 / 回滚', '', 'r', '', '## 进度记录', '', '- 2026-11-07 建立', '',
  ].join('\r\n');
  const fMixed = path.join(WS, 'PLAN-dec-mixed.md');
  fs.writeFileSync(fMixed, mixedHead + '\n' + mixedBody, 'utf8');
  plan.addDecisionTicket(fMixed, { title: '混合票', type: 'task', question: 'q' });
  const mixedText = fs.readFileSync(fMixed, 'utf8');
  ok(
    '30.9 混合 EOL：frontmatter 仍 LF、正文仍 CRLF、票已写入',
    mixedText.startsWith('---\n') && mixedText.includes('\r\n') && mixedText.includes('### T-01 混合票'),
    JSON.stringify({ head: mixedText.slice(0, 8), crlf: mixedText.includes('\r\n') }),
  );
}

// 31. 工具面返回值可无损序列化（2026-11-07 回归：check 的 rows[].decisions=undefined → 宿主判 not lossless JSON，工具整体不可用）
{
  const undefinedPaths = (o, p = 'r', out = []) => {
    if (o && typeof o === 'object') {
      for (const k of Object.keys(o)) {
        if (o[k] === undefined) out.push(`${p}.${k}`);
        else undefinedPaths(o[k], `${p}.${k}`, out);
      }
    }
    return out;
  };

  const saved = save('dec-plain-tool-check'); // 不传 decisions → 无「## 决策票据」节
  const one = await callTool('steward_plan', { action: 'check', plan: saved.file });
  const badOne = undefinedPaths(one);
  ok(
    '31.1 工具面 check（无票据节）：可返回且返回值无 undefined 属性',
    badOne.length === 0 && String(one.text).includes('计划检查 1 份'),
    JSON.stringify(badOne.slice(0, 3)),
  );
  ok(
    '31.2 check 的 rows 里该计划不带 decisions 键（不是挂 undefined）',
    Array.isArray(one.rows) && one.rows.length === 1 && !('decisions' in one.rows[0]),
    JSON.stringify(Object.keys(one.rows?.[0] ?? {})),
  );

  const all = await callTool('steward_plan', { action: 'check' });
  const badAll = undefinedPaths(all);
  ok(
    '31.3 全量 check 返回值同样无 undefined（多份计划回归面）',
    badAll.length === 0 && (all.rows?.length ?? 0) > 1,
    `${all.rows?.length ?? 0} 份 / ${badAll.slice(0, 3).join(',')}`,
  );
}

console.log(out.join('\n'));
console.log(`\n隔离 HOME：${HOME}`);
process.exit(out.some((l) => l.startsWith('FAIL')) ? 1 : 0);
