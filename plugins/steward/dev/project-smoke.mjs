/**
 * 项目统管回归（2026-11-03 防御性补齐）：不碰真实 ~/.dsh。
 * 覆盖：拒写手写文档 / 写前备份 / projects.json 坏文件拒写 + 原子写 / 同日二次 close 不覆盖 /
 *      已收尾拒写 + reopen / 账本 type 透传。
 * 用法：node dev/project-smoke.mjs   （退出码 1 = 有失败）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.join(HERE, '.home-project');
fs.rmSync(HOME, { recursive: true, force: true });
const DSH = path.join(HOME, '.dsh');
const WS = path.join(HERE, '.ws-project');
fs.rmSync(WS, { recursive: true, force: true });
fs.mkdirSync(DSH, { recursive: true });
fs.mkdirSync(WS, { recursive: true });
process.env.KOUJING_HOME = HOME;

const fails = [];
const check = (cond, msg, extra = '') => {
  if (cond) console.log(`  [OK]   ${msg}`);
  else {
    console.log(`  [FAIL] ${msg}${extra ? ` —— ${extra}` : ''}`);
    fails.push(msg);
  }
};
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

const P = await import('../lib/project.js');
const C = await import('../lib/change.js');
const REG = path.join(DSH, 'projects.json');

console.log('=== 1. statusFile 指向手写文档：拒写且原文零改动 ===');
const doc = path.join(WS, 'RUNBOOK-手动.md');
fs.writeFileSync(doc, '# 手写 RUNBOOK\n\n1. 打开 RustDesk\n2. 输入 ID\n', 'utf8');
const h0 = sha(doc);
let refused = '';
try {
  P.registerProject({ key: 'rd', title: '远程桌面', source: WS, statusFile: doc, handoffDir: WS });
} catch (e) {
  refused = e.message;
}
check(refused.includes('不是 koujing 生成的'), '注册时就拒绝指向手写文档', refused);
check(sha(doc) === h0, '手写文档未被改动（sha256 相同）');
check(!fs.existsSync(REG), 'projects.json 未被创建（失败不落半截状态）');

console.log('=== 2. 正常登记 + 生成 STATUS + 写前备份 ===');
const st = path.join(WS, 'STATUS.md');
P.registerProject({ key: 'demo', title: '演示', source: WS, statusFile: st, handoffDir: WS });
const r1 = P.writeStatus(P.getProject('demo'));
check(fs.existsSync(st) && /当前态（STATUS）/.test(fs.readFileSync(st, 'utf8')), 'STATUS 已生成且带生成标记');
check(r1.backup === null, '首次写没有旧文件，backup=null');
const r2 = P.writeStatus(P.getProject('demo'));
check(!!r2.backup && fs.existsSync(r2.backup), '第二次写前留了备份');
check(fs.readdirSync(DSH).every((n) => !n.includes('.tmp-')), '没有残留 .tmp 文件');

console.log('=== 3. projects.json 坏文件：读/写都拒绝，原文件不动 ===');
const good = fs.readFileSync(REG, 'utf8');
fs.writeFileSync(REG, '{"version":1,"projects":{"demo":{', 'utf8');
const hBad = sha(REG);
let readErr = '';
try {
  P.loadProjects();
} catch (e) {
  readErr = e.message;
}
check(readErr.includes('解析失败'), 'loadProjects 对坏文件抛错（不再吞成空表）');
let writeErr = '';
try {
  P.registerProject({ key: 'other', title: 'X', source: WS });
} catch (e) {
  writeErr = e.message;
}
check(writeErr.includes('解析失败'), '坏文件下 register 拒绝写');
check(sha(REG) === hBad, '坏文件未被覆盖（sha256 相同）');
fs.writeFileSync(REG, good, 'utf8');

console.log('=== 4. 同日二次 close：不覆盖第一份冻结件 ===');
P.writeStatus(P.getProject('demo'));
const a = P.closeProject('demo', { note: '第一次收尾' });
const b = P.closeProject('demo', { note: '第二次收尾' });
check(a.handoff !== b.handoff, '两次 close 落到不同文件', `${a.handoff} / ${b.handoff}`);
check(fs.readFileSync(a.handoff, 'utf8').includes('第一次收尾'), '第一份快照内容仍在');

console.log('=== 5. 已收尾拒写；reopen 后可再写 ===');
let closedErr = '';
try {
  P.writeStatus(P.getProject('demo'));
} catch (e) {
  closedErr = e.message;
}
check(closedErr.includes('收尾'), '收尾后 status 被拒绝（不再复活）', closedErr);
check(P.getProject('demo').closedAt, '档案记了 closedAt');
P.updateProject('demo', { status: 'active' });
check(!P.getProject('demo').closedAt, 'reopen 清掉 closedAt');
P.writeStatus(P.getProject('demo'));
check(/当前态（STATUS）/.test(fs.readFileSync(st, 'utf8')), 'reopen 后可以重新生成 STATUS');

console.log('=== 6. 账本 type 落盘（lib 层） ===');
C.appendChange({ object: 'demo', type: '报错', change: '模拟一次报错', evidence: 'exit 1', rollback: '无' });
const row = C.listChanges(5).find((x) => x.change === '模拟一次报错');
check(row && row.type === '报错', 'type=报错 落盘后能读回', row?.type);

console.log('=== 7. 账本对象别名（ledgerKeys） ===');
C.appendChange({ object: 'ego-merged', change: '改了合并包入口', evidence: 'exit 0' });
P.registerProject({ key: 'ego', title: 'ego 采集', source: WS, statusFile: path.join(WS, 'S-ego.md'), ledgerKeys: ['ego-merged', 'ego-package'] });
const stEgo = P.renderStatus(P.getProject('ego'));
check(stEgo.includes('改了合并包入口'), '项目 key=ego 能读到 ego-merged 名下的记录');
check(stEgo.includes('证据：exit 0'), '改动行带证据摘要');

console.log('=== 8. 删档案（只删档案） ===');
const before = Object.keys(P.loadProjects()).length;
const rm = P.removeProject('ego');
check(!P.loadProjects().ego, 'ego 档案已删除');
check(Object.keys(P.loadProjects()).length === before - 1, '其他档案不受影响');
check(fs.existsSync(WS), '项目目录没被删');
let rmErr = '';
try {
  P.removeProject('ego');
} catch (e) {
  rmErr = e.message;
}
check(rmErr.includes('没有登记过'), '删不存在的项目报错而不是静默成功');

console.log('=== 9. 健康度：计划缺失告警、源目录必须存在 ===');
const reg2 = P.registerProject({ key: 'noplan', title: '无计划', source: WS, statusFile: path.join(WS, 'S2.md'), plan: path.join(WS, 'PLAN-不存在.md') });
check(reg2.warnings.length === 1 && reg2.warnings[0].includes('计划文件不存在'), '计划缺失给警告');
const h = P.healthOf(P.getProject('noplan'));
check(h.planOk === false, 'healthOf 标出计划缺失');
let srcErr = '';
try {
  P.registerProject({ key: 'bad', title: 'X', source: path.join(WS, '没有这个目录') });
} catch (e) {
  srcErr = e.message;
}
check(srcErr.includes('source 不存在'), '源目录不存在时拒绝登记');

console.log('=== 10. STATUS 渲染覆盖所有 bullet 分支（空数组不触发 bullet，曾漏测） ===');
P.registerProject({
  key: 'full',
  title: '全字段',
  source: WS,
  statusFile: path.join(WS, 'S-full.md'),
  entry: ['双击 入口.bat'],
  rules: ['本体直跑'],
  outputs: [{ name: '成品', path: path.join(WS, 'out') }],
  frozen: [{ name: '旧版', path: path.join(WS, 'old') }],
  todo: ['待重跑'],
});
const full = P.renderStatus(P.getProject('full'));
check(full.includes('双击 入口.bat') && full.includes('生成物 · 成品') && full.includes('待重跑'), 'entry/outputs/todo 都渲染出来');
const w = P.writeStatus(P.getProject('full'));
check(fs.existsSync(w.file), '全字段项目能落盘');

console.log('=== 11. updateProject 白名单：拼错字段名必须报错，不许静默写入 ===');
let unkErr = '';
try {
  P.updateProject('full', { tile: '拼错' });
} catch (e) {
  unkErr = e.message;
}
check(unkErr.includes('不认字段') && unkErr.includes('tile'), '未知字段直接报错', unkErr);
check(!('tile' in P.getProject('full')), '未知字段没被写进档案');
let stErr = '';
try {
  P.updateProject('full', { status: 'archived' });
} catch (e) {
  stErr = e.message;
}
check(stErr.includes('active / paused / done'), 'status 非法值被拒绝', stErr);
let srcErr2 = '';
try {
  P.updateProject('full', { source: path.join(WS, '不存在') });
} catch (e) {
  srcErr2 = e.message;
}
check(srcErr2.includes('source 不存在'), 'update 改到不存在的源目录被拒绝', srcErr2);

console.log('');
if (fails.length) {
  console.log(`结果：${fails.length} 条失败`);
  process.exit(1);
}
console.log('结果：全部通过');
