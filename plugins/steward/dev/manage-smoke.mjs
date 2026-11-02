/**
 * 隔离冒烟：项目档案 / 交接 / 收尾 / 过程日志 / 时间线（不碰真实 ~/.dsh）。
 * 用法：node dev/manage-smoke.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.join(HERE, '.home-manage');
const DSH = path.join(HOME, '.dsh');
const WS = path.join(HERE, '.ws-manage');

fs.rmSync(HOME, { recursive: true, force: true });
fs.rmSync(WS, { recursive: true, force: true });
fs.mkdirSync(path.join(DSH, 'koujing'), { recursive: true });
fs.mkdirSync(path.join(DSH, 'storages'), { recursive: true });
fs.mkdirSync(WS, { recursive: true });
process.env.KOUJING_HOME = HOME;

const fails = [];
const check = (cond, msg) => {
  if (cond) console.log('  [OK]   ' + msg);
  else { console.log('  [FAIL] ' + msg); fails.push(msg); }
};

const { appendChange, listChanges } = await import('../lib/change.js');
const { appendLog, listLogs } = await import('../lib/log.js');
const { registerProject, getProject, updateProject, writeStatus, closeProject, renderStatus } = await import('../lib/project.js');
const { buildTimeline } = await import('../lib/timeline.js');

// 假计划
const planFile = path.join(WS, 'PLAN-demo.md');
fs.writeFileSync(planFile, [
  '---', 'title: 演示项目', 'status: active', 'created: 2026-11-03', 'updated: 2026-11-03', '---', '',
  '# 演示项目', '', '## 目标', '', '验证项目统管闭环。', '', '## 步骤', '',
  '- [x] 1. 建档', '- [ ] 2. 收尾', '',
].join('\n'), 'utf8');

console.log('=== 1. 登记项目档案 ===');
const reg = registerProject({
  key: 'demo',
  title: '演示项目',
  source: WS,
  plan: planFile,
  statusFile: path.join(WS, 'STATUS.md'),
  handoffDir: WS,
  gate: 'D:\\dsh\\tools\\gate.cmd',
  entry: ['双击 入口.bat', '入口.bat "源" -Copy'],
  rules: ['本体直跑，不复制'],
  outputs: [{ name: '成品', path: path.join(WS, 'out') }],
  frozen: [{ name: '旧版', path: path.join(WS, 'old'), note: '被取代' }],
  todo: ['待重跑'],
});
check(fs.existsSync(path.join(DSH, 'projects.json')), 'projects.json 已建');
check(getProject('demo').title === '演示项目', 'getProject 取到 title');

console.log('=== 2. 生成 STATUS（含计划进度 / 改动 / 日志） ===');
appendChange({ object: 'demo', type: '改动', change: '第一步改了入口', evidence: 'exit 0', rollback: '删', pointer: 'STATUS.md' });
appendLog({ project: 'demo', type: '运行', text: '批量跑完 6 支，exit 0' });
const st = writeStatus(getProject('demo'));
const statusText = fs.readFileSync(st.file, 'utf8');
check(/## 四、计划进度/.test(statusText), 'STATUS 有计划进度节');
check(statusText.includes('1/2'), '计划进度 1/2 已渲染');
check(statusText.includes('第一步改了入口'), '最近改动已并入');
check(statusText.includes('批量跑完 6 支'), '过程日志已并入');
check(/最后更新：\d{4}-\d\d-\d\d \d\d:\d\d/.test(statusText), 'STATUS 有真实时间戳');

console.log('=== 3. 过程日志读写 ===');
appendLog({ project: 'demo', type: '报错', text: 'robocopy 失败 exit 8' });
const logs = listLogs('demo');
check(logs.length === 2, `listLogs 返回 ${logs.length} 条（期望 2）`);
check(logs[1].type === '报错', '类型写入正确');
check(logs[1].text.includes('robocopy 失败'), '正文写入正确');

console.log('=== 4. 时间线合并账本 + 日志 ===');
const tl = buildTimeline();
check(tl.events.some((e) => e.source === 'CHANGES.md'), '时间线含 CHANGES.md 来源');
check(tl.events.some((e) => e.source === 'logs'), '时间线含 logs 来源');
check(tl.events.some((e) => e.kind === 'error'), '报错类日志标成 error');

console.log('=== 5. 收尾：冻结快照 + STATUS 标记 + 计划 done ===');
const before = listChanges(0).length;
const r = closeProject('demo', { note: '冒烟收尾' });
const day = new Date();
const p2 = (n) => String(n).padStart(2, '0');
const dayStr = `${day.getFullYear()}-${p2(day.getMonth() + 1)}-${p2(day.getDate())}`;
check(fs.existsSync(r.handoff), '快照文件存在：' + path.basename(r.handoff));
check(path.basename(r.handoff) === `HANDOFF-${dayStr}.md`, '快照命名 HANDOFF-<日期>.md');
check(fs.readFileSync(r.handoff, 'utf8').includes('收尾交接'), '快照有收尾标题');
check(fs.readFileSync(st.file, 'utf8').includes('已收尾'), 'STATUS 顶部标已收尾');
check(fs.readFileSync(planFile, 'utf8').includes('status: done'), '计划已标 done');
check(listChanges(0).length === before + 1, '收尾在账本记了一行');
check(getProject('demo').status === 'done', '项目档案 status=done');

fs.rmSync(HOME, { recursive: true, force: true });
fs.rmSync(WS, { recursive: true, force: true });
console.log('');
if (fails.length) { console.log(`结果：${fails.length} 项失败`); process.exit(1); }
console.log('结果：全部通过（已清理 .home-manage / .ws-manage）');
process.exit(0);
