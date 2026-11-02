/**
 * 隔离冒烟：用临时 HOME 跑一遍核心逻辑，不碰真实 ~/.dsh/AGENTS.md。
 * 用法：node dev/smoke.mjs
 *
 * 夹具全部在运行时生成（dev/.home、dev/.ws、dev/.ws2），已在 .gitignore 里；
 * 内容全是捏造的例子，不含任何真实规则。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.join(HERE, '.home');
const WS = path.join(HERE, '.ws');
const WS2 = path.join(HERE, '.ws2');
const DSH = path.join(HOME, '.dsh');

fs.rmSync(HOME, { recursive: true, force: true });
fs.rmSync(WS, { recursive: true, force: true });
fs.rmSync(WS2, { recursive: true, force: true });
fs.mkdirSync(path.join(DSH, 'storages'), { recursive: true });
fs.mkdirSync(path.join(DSH, 'koujing'), { recursive: true });
fs.mkdirSync(WS, { recursive: true });
fs.mkdirSync(WS2, { recursive: true });

fs.writeFileSync(
  path.join(DSH, 'AGENTS.md'),
  [
    '# 用户级约定',
    '',
    '## 提交前先跑测试',
    '',
    '- 提交前先跑测试，别直接提交。',
    '',
    '## 依赖升级先看日志',
    '',
    '- 升级依赖前先看 release note。',
    '',
    '## 文档不加装饰',
    '',
    '- 没明说的排版一律不加装饰。',
    '',
  ].join('\n'),
  'utf8',
);
fs.writeFileSync(path.join(WS, 'AGENTS.md'), '# 工作区约定\n\n## 构建与测试\n\n- 构建脚本统一放 scripts 目录。\n', 'utf8');
fs.writeFileSync(
  path.join(DSH, 'storages', 'workspace.json'),
  JSON.stringify({ tables: { workspaces: { a: { path: WS, title: 'demo-ws' }, b: { path: WS2, title: 'demo-project' } } } }),
  'utf8',
);
// 领域路由表也是可选配置：这里造一份假的，验证 domains.json 生效
fs.writeFileSync(
  path.join(DSH, 'koujing', 'domains.json'),
  JSON.stringify({ routes: [{ pattern: '插件|profile', workspace: 'demo-project', tag: '插件' }] }),
  'utf8',
);

process.env.KOUJING_HOME = HOME;
process.env.KOUJING_ISOLATED = '1';
const core = await import('../lib/core.js');

const out = [];
const ok = (name, cond, extra = '') => out.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`);

// 1 类型判断
ok('detectKind rule', core.detectKind('记住：以后提交前一律先跑测试') === 'rule');
ok('detectKind project', core.detectKind('帮我做一个数据导出工具的项目') === 'project');
ok('detectKind requirement', core.detectKind('把这份表格整理一下') === 'requirement');
// 2026-10-31：禁止语气与「以后必须 / 每次都要」以前漏判成 requirement 或漏提醒
ok('detectKind 别再→rule', core.detectKind('别再动我的桌面文件') === 'rule');
ok('detectKind 不要再→rule', core.detectKind('不要再把截图发到网盘') === 'rule');
ok('detectKind 以后必须→rule', core.detectKind('以后必须每次先报环境') === 'rule');
ok('looksLikeRule 覆盖每次都要', core.looksLikeRule('每次都要先问我') === true);
ok('looksLikeRule 不误伤请求', core.looksLikeRule('把这份表格整理一下') === false);
ok('looksLikeRule 不误伤不要加装饰', core.looksLikeRule('不要加装饰') === false);
ok('blindspot 整理表格不报外传', !core.blindspotsFor('把这份表格整理一下', 'requirement').some((b) => b.id === 'export'));
ok('blindspot 桌面文件不报平台差异', !core.blindspotsFor('别再动我的桌面文件', 'rule').some((b) => b.id === 'cross'));
ok('blindspot ps1 命中脚本编码', core.blindspotsFor('以后改 ps1 文件先看 BOM', 'rule').some((b) => b.id === 'script'));
ok('blindspot 发网盘命中外传', core.blindspotsFor('把截图发到网盘', 'rule').some((b) => b.id === 'export'));
ok('rule 维度有怎么验', core.checklist('rule', { scope: 'user', wsTitle: 'demo-project' }, '记住：以后一律先备份').some((d) => d.id === 'check'));

// 2 落点：domains.json 生效 / 点名工作区 / 都不命中判用户级
const p1 = core.pickPlacement('以后装插件之前一律先给 profile 快照');
ok('placement 路由表→工作区', p1.scope === 'workspace' && p1.wsTitle === 'demo-project', p1.reason);
const p1b = core.pickPlacement('demo-ws 的构建脚本要先加注释');
ok('placement 点名工作区→落它', p1b.scope === 'workspace' && p1b.wsTitle === 'demo-ws', p1b.reason);
const p2 = core.pickPlacement('以后回答我时先给结论');
ok('placement 通用→用户级', p2.scope === 'user', p2.reason);

// 3 小节
const s1 = core.pickSection(path.join(DSH, 'AGENTS.md'), '以后每次提交前都要先跑测试');
ok('section 提交→提交前先跑测试', s1.heading === '提交前先跑测试', s1.heading);
const s2 = core.pickSection(path.join(DSH, 'AGENTS.md'), '文档不要加装饰，字体默认');
ok('section 排版', s2.heading === '文档不加装饰', s2.heading);

// 4 冲突
const c = core.findConflicts('提交前先跑测试');
ok('conflict 命中提交节', c.length > 0 && c[0].heading === '提交前先跑测试', `${c.length} 条`);

// 5 写入
const r1 = core.commitRule({
  title: '提交前跑测试',
  body: '提交前先跑 test，不通过就停。',
  scope: 'user',
});
ok('commit written', r1.status === 'written', `${r1.file}:${r1.lines?.[0]} ## ${r1.heading}`);
const after = fs.readFileSync(path.join(DSH, 'AGENTS.md'), 'utf8');
ok('commit 行存在', after.includes('提交前先跑 test，不通过就停。'));

// 6 查重
const r2 = core.commitRule({ title: '重复', body: '提交前先跑 test，不通过就停。', scope: 'user' });
ok('commit 查重', r2.status === 'duplicate', r2.status);

// 7 台账
const led = core.ledgerReport();
ok('ledger 有 1 条且可定位', led.length === 1 && led[0].found === true, JSON.stringify(led.map((x) => [x.title, x.found, x.line])));

// 8 检索
const hits = core.searchRules('提交 test');
ok('search 命中写入行', hits.some((h) => h.text.includes('提交前先跑 test')), `${hits.length} 条`);

// 9 工作区写入
const r3 = core.commitRule({
  title: '构建前确认工具链',
  body: '构建前先确认工具链版本。',
  scope: 'workspace',
  wsPath: WS,
  section: '构建与测试',
});
ok('commit 工作区', r3.status === 'written' && r3.heading === '构建与测试', `${r3.file}:${r3.lines?.[0]}`);
ok('工作区文件含行', fs.readFileSync(path.join(WS, 'AGENTS.md'), 'utf8').includes('构建前先确认工具链版本'));

// 10 备份存在
ok('备份已生成', Boolean(r1.backup && fs.existsSync(r1.backup)));

// 11 计划：建 / 列 / 读 / 更新
const plan = await import('../lib/plan.js');
const plan1 = plan.savePlan({
  workspace: WS,
  title: 'demo-project',
  goal: '让模型不再猜用户的规定',
  scope: '- 做：卡片、落盘、台账\n- 不做：自动改代码',
  steps: ['写 core', '写 plan', '做面板'],
  accept: '六个工具真实往返通过',
  risks: '改 profile 前先快照',
});
ok('plan save', plan1.created === true && fs.existsSync(plan1.file), plan1.file);
ok('plan file name', path.basename(plan1.file) === 'PLAN-demo-project.md', path.basename(plan1.file));
const all = plan.listPlans();
ok('plan list', all.length === 1 && all[0].steps === 3, JSON.stringify(all.map((x) => [x.title, x.steps])));
const g = plan.getPlan('demo-project');
ok('plan get 有步骤', g.parsed.steps.length === 3 && g.parsed.steps[0].text === '写 core');
const u = plan.updatePlan({ ref: path.join(WS, 'PLAN-demo-project.md'), stepDone: 2, status: 'active', progress: 'plan 写完了' });
ok('plan update 勾步骤', u.steps.filter((s) => s.done).length === 1, JSON.stringify(u.steps.map((s) => s.done)));
const txt = fs.readFileSync(plan1.file, 'utf8');
ok('plan 进度已记录', txt.includes('plan 写完了') && txt.includes('- [x] 2.'), txt.split('\n').filter((l) => l.includes('plan 写完了')).join());
ok('plan 标题没被粘住', /^## 步骤$/m.test(txt) && /^## 进度记录$/m.test(txt), txt.split('\n').filter((l) => l.startsWith('##')).join(' | '));
const u2 = plan.updatePlan({ ref: path.join(WS, 'PLAN-demo-project.md'), stepDone: 3, progress: '第二次更新' });
ok('plan 连续更新仍可解析', u2.steps.length === 3 && u2.steps[2].done === true, JSON.stringify(u2.steps.map((s) => s.done)));
plan.savePlan({ workspace: WS, title: 'demo-project' });
ok('plan 重存保留进度', fs.readFileSync(plan1.file, 'utf8').includes('第二次更新'));

// 12 计划更新语义（mode=merge / append / replace，2026-10-31）
const pfile = plan1.file;
const base = fs.readFileSync(pfile, 'utf8');
ok('12.0 比对口径忽略空白与全半角', plan.normStep('写 plan') === plan.normStep('写plan') && plan.normStep('（做）面板') === plan.normStep('(做)面板'));
// 手写小节：用户自己加的 ## 备注
fs.writeFileSync(pfile, `${base.replace(/\n$/, '')}\n## 备注\n\n用户自己加的一行\n`, 'utf8');
const m1 = plan.savePlan({ workspace: WS, title: 'demo-project', steps: ['写 plan', '新步骤：面板联调'] });
const q1 = plan.parsePlan(fs.readFileSync(pfile, 'utf8'));
ok(
  '12.1 merge 只加新步骤、旧步骤与勾选不丢',
  q1.steps.length === 4 && q1.steps[1].done === true && q1.steps[3].text === '新步骤：面板联调',
  JSON.stringify(q1.steps.map((s) => [s.text, s.done])),
);
ok('12.2 merge 保留手写小节', q1.extras.length === 1 && q1.extras[0].name === '备注', JSON.stringify(q1.extras.map((e) => e.name)));
ok('12.3 merge 报告命中/新增/保留', m1.steps.matched === 1 && m1.steps.added === 1 && m1.steps.kept === 3, JSON.stringify(m1.steps));
const m2 = plan.savePlan({ workspace: WS, title: 'demo-project', mode: 'append', scope: '- 不做：自动合并同名计划' });
const q2 = plan.parsePlan(fs.readFileSync(pfile, 'utf8'));
ok(
  '12.4 append 追加到节末且保留原文',
  q2.scope.includes('做：卡片') && q2.scope.includes('自动合并同名计划') && m2.sections.appended.includes('scope'),
  q2.scope.replace(/\n/g, ' | '),
);
const m2b = plan.savePlan({ workspace: WS, title: 'demo-project', mode: 'append', scope: '- 不做：自动合并同名计划' });
ok('12.5 append 同一段不重复追加', !m2b.sections.appended.includes('scope') && fs.readFileSync(pfile, 'utf8').split('自动合并同名计划').length === 2);
const m3 = plan.savePlan({ workspace: WS, title: 'demo-project', mode: 'replace', goal: '重写后的目标' });
const q3 = plan.parsePlan(fs.readFileSync(pfile, 'utf8'));
ok('12.6 replace 未传必填节填空', q3.accept === '（待补）' && q3.goal === '重写后的目标', JSON.stringify([q3.goal, q3.accept]));
ok('12.7 replace 丢弃手写小节并报告', q3.extras.length === 0 && m3.sections.droppedExtras.includes('备注'), JSON.stringify(m3.sections.droppedExtras));
ok('12.8 replace 不清进度记录', q3.progress.includes('第二次更新'), q3.progress.replace(/\n/g, ' | '));
const q4 = plan.parsePlan(fs.readFileSync(pfile, 'utf8'));
ok('12.9 replace 不传 steps 时旧步骤仍在', q4.steps.length === 4, `${q4.steps.length} 步`);

console.log(out.join('\n'));
console.log(`\n台账文件：${core.ledgerPath()}`);
process.exit(out.some((l) => l.startsWith('FAIL')) ? 1 : 0);
