/**
 * 收尾复盘回归（retro 原文口径，PLAN-决策票据与开发规范落地 步骤 10）：不碰真实 ~/.dsh。
 * 覆盖：7 类 + 严重度 + 落点校验 / 校验失败不写任何文件 / 严重度排序 / 机械问题必须写检查 /
 *      写进 HANDOFF「## 九、复盘」并追加 project.todo / 不覆盖 STATUS 第二节 / 重复收尾不重复写 todo /
 *      不带 retro 时行为与旧版一致（回归）。
 * 用法：node dev/retro-smoke.mjs   （退出码 1 = 有失败）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.join(HERE, '.home-retro');
fs.rmSync(HOME, { recursive: true, force: true });
const DSH = path.join(HOME, '.dsh');
const WS = path.join(HERE, '.ws-retro');
fs.rmSync(WS, { recursive: true, force: true });
fs.mkdirSync(DSH, { recursive: true });
fs.mkdirSync(WS, { recursive: true });
process.env.KOUJING_HOME = HOME;
process.env.KOUJING_ISOLATED = '1';

const P = await import('../lib/project.js');
const { apply } = await import('../index.js');

const fails = [];
const check = (cond, msg, extra = '') => {
  if (cond) console.log(`  [OK]   ${msg}`);
  else {
    console.log(`  [FAIL] ${msg}${extra ? ` —— ${extra}` : ''}`);
    fails.push(msg);
  }
};
const readOr = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
/** 取 STATUS 的第二节原文（含标题到下一节前），用于「字节未变」断言。 */
const section2 = (text) => {
  const i = text.indexOf('## 二、入口');
  const j = text.indexOf('## 三、', i);
  return i < 0 || j < 0 ? '' : text.slice(i, j);
};

/** 一个够 close 用的最小计划（六节齐全、无决策票据节）。 */
function writePlan(file) {
  fs.writeFileSync(
    file,
    [
      '---',
      'title: 演示项目',
      'status: active',
      '---',
      '',
      '# 演示项目',
      '',
      '## 目标',
      '演示收尾',
      '',
      '## 范围',
      '做：最小一条',
      '',
      '## 步骤',
      '- [x] 1. 做完 — [High] [自做]',
      '',
      '## 验收',
      '跑通一次',
      '',
      '## 风险 / 回滚',
      '删文件即可',
      '',
      '## 进度记录',
      '- 2026-11-07 建',
      '',
    ].join('\n'),
    'utf8',
  );
}

const RETRO = [
  { category: 'checks', severity: 'medium', finding: '改完没跑夹具就报完成，灯下黑', mechanical: true, evidence: 'logs/demo.md 第 12 行' },
  { category: 'navigation', severity: 'low', finding: '找入口花了 6 步，应该加一行指针' },
  { category: 'standards', severity: 'high', finding: '手改了生成的 STATUS，没人拦', mechanical: false, landing: '改规则' },
];

console.log('=== 1. 不带 retro：与旧版一致（回归） ===');
const p1 = path.join(WS, 'demo1');
fs.mkdirSync(p1, { recursive: true });
P.registerProject({ key: 'demo1', title: '无复盘', source: p1, statusFile: path.join(p1, 'STATUS.md'), handoffDir: p1 });
P.writeStatus(P.getProject('demo1'));
const before1 = readOr(path.join(p1, 'STATUS.md'));
const r1 = P.closeProject('demo1', { note: '不带复盘' });
check(!/## 九、复盘/.test(readOr(r1.handoff)), '快照里没有复盘节');
check((P.getProject('demo1').todo ?? []).length === 0, 'todo 没被写');
check(Math.abs(section2(before1).length - section2(readOr(path.join(p1, 'STATUS.md'))).length) === 0, 'STATUS 第二节字节未变', `${section2(before1).length}`);

console.log('=== 2. 带 retro：排序 + 写进快照 + 写进 todo + STATUS 第二节不动 ===');
const p2 = path.join(WS, 'demo2');
fs.mkdirSync(p2, { recursive: true });
const plan2 = path.join(WS, 'PLAN-demo2.md');
writePlan(plan2);
P.registerProject({ key: 'demo2', title: '带复盘', source: p2, statusFile: path.join(p2, 'STATUS.md'), handoffDir: p2, plan: plan2 });
P.writeStatus(P.getProject('demo2'));
const statusBefore = readOr(path.join(p2, 'STATUS.md'));
const r2 = P.closeProject('demo2', { note: '带复盘收尾', retro: RETRO });
const hand2 = readOr(r2.handoff);
check(hand2.includes('## 九、复盘（候选改进项）'), '快照里有「## 九、复盘」节');
check(hand2.includes('机械问题必须写检查'), '快照里写明机械问题口径');
const order = ['[高]', '[中]', '[低]'].map((s) => hand2.indexOf(`${s} `));
check(order[0] > -1 && order[0] < order[1] && order[1] < order[2], '按严重度从高到低排列', order.join(','));
check(/\[中\] 自动检查：改完没跑夹具/.test(hand2) && hand2.includes('证据：logs/demo.md 第 12 行'), '类别 / 发现 / 证据都渲染出来');
check(hand2.includes('落点：改检查') && hand2.includes('落点：改规则'), '显式落点与默认落点都写出来');
check(r2.retro.length === 3 && r2.todoAdded.length === 3, '返回 3 条复盘、3 条新 todo', `${r2.todoAdded.length}`);
const todo2 = P.getProject('demo2').todo;
check(
  todo2.length === 3 && todo2[0].startsWith('复盘[高] 编码规范：') && todo2[2].startsWith('复盘[低] 导航：'),
  'project.todo 按同样顺序落盘',
  todo2.join(' | '),
);
const statusAfter = readOr(path.join(p2, 'STATUS.md'));
check(section2(statusAfter) === section2(statusBefore), 'STATUS 第二节字节未变（不被复盘覆盖）');
check(/## 九、复盘/.test(statusAfter) === false, 'STATUS 里不写复盘（只有快照有）');

console.log('=== 3. 校验失败：一个字节都不写 ===');
const cases = [
  [{ category: 'unknown', severity: 'high', finding: 'x' }, 'category'],
  [{ category: 'checks', severity: 'urgent', finding: 'x' }, 'severity'],
  [{ category: 'checks', severity: 'high', finding: '  ' }, 'finding'],
  [{ category: 'checks', severity: 'high', finding: 'x', landing: '写文档' }, 'landing'],
  [{ category: 'standards', severity: 'high', finding: 'x', mechanical: true, landing: '改规则' }, '机械问题要写成检查'],
];
for (const [item, want] of cases) {
  const dir = path.join(WS, `bad-${want}`);
  fs.mkdirSync(dir, { recursive: true });
  const key = `bad-${Buffer.from(want).toString('hex').slice(0, 6)}`;
  P.registerProject({ key, title: '坏复盘', source: dir, statusFile: path.join(dir, 'STATUS.md'), handoffDir: dir });
  P.writeStatus(P.getProject(key));
  const filesBefore = fs.readdirSync(dir).sort().join(',');
  let err = '';
  try {
    P.closeProject(key, { retro: [item] });
  } catch (e) {
    err = e.message;
  }
  const filesAfter = fs.readdirSync(dir).sort().join(',');
  check(err.includes(want), `拒绝：${want}`, err);
  check(filesBefore === filesAfter, `拒绝后目录没多文件（无半截 HANDOFF）——${want}`, filesAfter);
  check(!P.getProject(key).closedAt, `拒绝后项目仍是 active——${want}`);
  check(!(P.getProject(key).todo ?? []).some((t) => String(t).startsWith('复盘[')), `拒绝后 todo 没被写——${want}`);
  P.removeProject(key);
}

console.log('=== 4. 7 类全认；省略 landing 时按类别默认 ===');
const cats = P.RETRO_CATEGORIES.map((c) => ({ category: c.id, severity: 'low', finding: `覆盖 ${c.id}` }));
const items = P.normalizeRetro(cats);
check(items.length === 7, '7 类都通过校验', `${items.length}`);
const byId = Object.fromEntries(items.map((x) => [x.category, x]));
check(byId.navigation.landing === '改指针' && byId.checks.landing === '改检查', '默认落点按类别给', `${byId.navigation.landing}/${byId.checks.landing}`);
check(byId.noops.landing === '不改' && byId.agents.landing === '改规则', '无效规则默认不改、AGENTS 默认改规则');

console.log('=== 5. 重复收尾：todo 不重复写，快照各自保留 ===');
const r5a = P.closeProject('demo2', { note: '第二次', retro: RETRO });
check(r5a.todoAdded.length === 0, '同样的复盘第二次不重复进 todo', `${r5a.todoAdded.length}`);
check(P.getProject('demo2').todo.length === 3, 'todo 仍是 3 条', `${P.getProject('demo2').todo.length}`);
check(r5a.handoff !== r2.handoff && /## 九、复盘/.test(readOr(r5a.handoff)), '第二份快照也带复盘节，且不覆盖第一份');

console.log('=== 6. 工具面：steward_handoff close 透传 retro，错误压成文本 ===');
const tools = new Map();
apply({
  effect: (fn) => fn(),
  tools: { register: (t) => tools.set(t.name, t) },
  get: () => undefined,
  inject: () => {},
  on: () => {},
  logger: { info() {}, warn() {} },
});
const handoffTool = tools.get('steward_handoff');
const p6 = path.join(WS, 'demo6');
fs.mkdirSync(p6, { recursive: true });
P.registerProject({ key: 'demo6', title: '工具面', source: p6, statusFile: path.join(p6, 'STATUS.md'), handoffDir: p6 });
P.writeStatus(P.getProject('demo6'));
const t6 = await handoffTool.execute({ action: 'close', key: 'demo6', retro: [{ category: 'economy', severity: 'high', finding: '一次 grep 打了 40 条', evidence: 'dev/xxx.mjs' }] });
check(t6.text.includes('复盘：1 条已写进快照'), '工具文本回报复盘条数', t6.text.split('\n').find((l) => l.includes('复盘')) ?? '');
check(t6.text.includes('[high] 工具经济'), '工具文本逐条列出复盘项');
const p6b = path.join(WS, 'demo6b');
fs.mkdirSync(p6b, { recursive: true });
P.registerProject({ key: 'demo6b', title: '工具面-坏', source: p6b, statusFile: path.join(p6b, 'STATUS.md'), handoffDir: p6b });
P.writeStatus(P.getProject('demo6b'));
const t6b = await handoffTool.execute({ action: 'close', key: 'demo6b', retro: [{ category: 'nope', severity: 'high', finding: 'x' }] });
check(t6b.text.startsWith('失败：') && t6b.text.includes('category'), '工具层把校验错误压成「失败：…」文本', t6b.text.slice(0, 90));
check(!fs.existsSync(path.join(p6b, 'HANDOFF-2026-11-07.md')) && !P.getProject('demo6b').closedAt, '工具层拒绝后没留半截状态');

console.log('');
if (fails.length) {
  console.log(`结果：${fails.length} 条失败`);
  process.exit(1);
}
console.log('结果：全部通过');
