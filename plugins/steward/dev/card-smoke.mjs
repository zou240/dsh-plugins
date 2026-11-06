/**
 * 深问模式回归（grilling 原文口径，PLAN-决策票据与开发规范落地 步骤 9）：不碰真实 ~/.dsh。
 * 覆盖：一轮问完整个 frontier / 每问带推荐答案 / 末尾出口判据 / 事实类留给 agent 查不占用户时间 /
 *      answered 进第二轮重算（命名空间、裸 id、未知 id）/ 只输出不拦动作。
 * 用法：node dev/card-smoke.mjs   （退出码 1 = 有失败）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.join(HERE, '.home-card');
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(path.join(HOME, '.dsh'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.dsh', 'AGENTS.md'), '# 用户级约定\n\n## 示例\n\n- 示例规则。\n', 'utf8');
process.env.KOUJING_HOME = HOME;
process.env.KOUJING_ISOLATED = '1';

const { apply } = await import('../index.js');

const fails = [];
const check = (cond, msg, extra = '') => {
  if (cond) console.log(`  [OK]   ${msg}`);
  else {
    console.log(`  [FAIL] ${msg}${extra ? ` —— ${extra}` : ''}`);
    fails.push(msg);
  }
};

const tools = new Map();
const ctx = {
  effect: (fn) => fn(),
  tools: { register: (t) => tools.set(t.name, t) },
  get: () => undefined,
  inject: () => {},
  on: () => {},
  logger: { info() {}, warn() {} },
};
apply(ctx);

const card = tools.get('steward_card');
const run = async (args) => card.execute(args, undefined);
const qLines = (text) => text.split('\n').filter((l) => /^ {2}Q\d+〔/.test(l));
const factLines = (text) => text.split('\n').filter((l) => /^ {2}- .*（dim:/.test(l));

console.log('=== 1. 项目卡：一轮问完 frontier + 每问推荐答案 + 出口判据 ===');
const stmt1 = '做一个从零搭建的采集流水线项目';
const r1 = await run({ statement: stmt1 });
const t1 = r1.text;
check(!t1.startsWith('失败'), '卡片正常返回（不抛错）', t1.slice(0, 80));
check(r1.card?.kind === 'project', 'kind 判成 project', r1.card?.kind);
check(t1.includes('深问 · 本轮 frontier'), '有「深问」段');
const q1 = qLines(t1);
check(q1.length >= 3, 'frontier 一次列出多个问题（不是一次一问）', `${q1.length} 问`);
check((t1.match(/➡️ 推荐：/g) ?? []).length === q1.length, '每问都带推荐答案', `${(t1.match(/➡️ 推荐：/g) ?? []).length} 条推荐`);
const paired = q1.every((line, i) => {
  const idx = t1.split('\n').indexOf(line);
  return (t1.split('\n')[idx + 1] ?? '').trim().startsWith('➡️ 推荐：');
});
check(paired, '每条问题的下一行就是它的推荐答案（问/答成对）');
check(t1.includes('出口判据：'), '末尾有出口判据');
check(/frontier 空/.test(t1), '出口判据写明「frontier 空 = 达成共识」');
check(t1.includes('只提示，不拦任何动作'), '明确只提示、不做硬门禁');

console.log('=== 2. 事实类问题不进「问用户」队列 ===');
check(t1.includes('先我自己查（事实类'), '有「先我自己查」段');
for (const id of ['depends', 'env', 'cost']) {
  check(t1.includes(`dim:${id}`) && !q1.some((l) => l.includes(`dim:${id}`)), `事实维度 ${id} 列在自查段、不在 Q 列表`);
}
check(factLines(t1).length === 3, '三个事实维度各一行', `${factLines(t1).length}`);

console.log('=== 3. answered 进第二轮：已答的不再问 ===');
const r2 = await run({ statement: stmt1, answered: ['dim:accept', 'deliverable', 'dim:depends'] });
const t2 = r2.text;
const q2 = qLines(t2);
check(q2.length === q1.length - 2, '两个决策维度已答 → Q 少 2 个', `${q1.length} → ${q2.length}`);
check(q2.length < q1.length, '第一轮维度问题全部保留（没有误删）');
check(!q2.some((l) => l.includes('dim:accept')), '已答维度 accept 不再出现在 Q 列表');
check(!q2.some((l) => l.includes('dim:deliverable')), '裸 id 也能命中（dim:deliverable）');
check(factLines(t2).length === 2, '已答的事实维度也退出自查段', `${factLines(t2).length}`);
check(t2.includes('上一轮已答'), '已答项在「必须明确」段标成已明确');

console.log('=== 4. 未知 id 明确提示，不静默吞掉 ===');
const r3 = await run({ statement: stmt1, answered: ['dim:no-such'] });
check(r3.text.includes('answered 里这些 id 不认识'), '未知 id 有提示行', r3.text.split('\n').find((l) => l.includes('不认识')) ?? '');
check(qLines(r3.text).length === q1.length, '未知 id 不影响 frontier');

console.log('=== 5. 盲点也进 frontier；spot: 命名空间可关闭单条 ===');
const stmt5 = '把这些文件上传到网盘备份';
const r5 = await run({ statement: stmt5 });
const q5 = qLines(r5.text);
check(q5.some((l) => l.includes('spot:export')), '外传盲点进了本轮 frontier', q5.join(' | '));
const r6 = await run({ statement: stmt5, answered: ['spot:export'] });
check(!qLines(r6.text).some((l) => l.includes('spot:export')), 'spot:export 已答 → 不再问');
check(r6.text.includes('✓ 上一轮已答'), '盲点段对应条目标已答');
const r6b = await run({ statement: stmt5, answered: ['export'] });
check(!qLines(r6b.text).some((l) => l.includes('spot:export')), '裸 id 在维度里没重名时也能命中盲点');

console.log('=== 6. 维度 / 盲点重名（cost）：裸 id 只命中维度，spot:cost 才命中盲点 ===');
const stmt7 = '做一个批量清理全部旧文件的项目';
const t7 = (await run({ statement: stmt7 })).text;
check(t7.includes('dim:cost') && qLines(t7).some((l) => l.includes('spot:cost')), '同一条卡里同时有 dim:cost 与 spot:cost');
const t7a = (await run({ statement: stmt7, answered: ['cost'] })).text;
check(!t7a.includes('（dim:cost）') && qLines(t7a).some((l) => l.includes('spot:cost')), '裸 cost 只关维度，盲点 cost 仍在');
const t7b = (await run({ statement: stmt7, answered: ['spot:cost'] })).text;
check(!qLines(t7b).some((l) => l.includes('spot:cost')) && t7b.includes('（dim:cost）'), 'spot:cost 只关盲点，维度 cost 仍在');

console.log('=== 7. 空 frontier：不再列问题，出口判据改口径 ===');
const allIds = qLines(t1)
  .map((l) => /〔[^ ]+ (dim:[^\]]+|spot:[^\]]+)〕/.exec(l)?.[1])
  .filter(Boolean);
const r8 = await run({ statement: stmt1, answered: allIds });
check(qLines(r8.text).length === 0, '全部答完 → 本轮 Q 为 0', allIds.join(','));
check(r8.text.includes('frontier 已空，可以开工'), '空 frontier 给出「可以开工」');

console.log('=== 8. 规定类也走同一口径（不是只对项目生效） ===');
const r9 = await run({ statement: '以后所有会话都必须先备份再删文件' });
check(r9.card?.kind === 'rule', 'kind 判成 rule', r9.card?.kind);
check(r9.text.includes('深问 · 本轮 frontier') && qLines(r9.text).length > 0, '规定卡也输出深问 frontier');

console.log('');
if (fails.length) {
  console.log(`结果：${fails.length} 条失败`);
  process.exit(1);
}
console.log('结果：全部通过');
