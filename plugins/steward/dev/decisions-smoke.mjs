/**
 * 决策票据 v1.2 夹具（SPEC §8，夹具 1–23；24/25 属关闭闸门，批次 2 第二步接）。
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
const { parseDecisions, renderDecisions } = plan;

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

console.log(out.join('\n'));
console.log(`\n隔离 HOME：${HOME}`);
process.exit(out.some((l) => l.startsWith('FAIL')) ? 1 : 0);
