/**
 * 隔离冒烟：只验「改动账本」这一层（lib/change.js）与时间线合并，不碰真实 ~/.dsh。
 * 用法：node dev/change-smoke.mjs
 * 夹具在 dev/.home-change 下运行时生成，跑完删除。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.join(HERE, '.home-change');
const DSH = path.join(HOME, '.dsh');

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(path.join(DSH, 'koujing'), { recursive: true });
process.env.KOUJING_HOME = HOME;

const fails = [];
const check = (cond, msg) => {
  if (cond) console.log('  [OK]   ' + msg);
  else { console.log('  [FAIL] ' + msg); fails.push(msg); }
};

const { appendChange, listChanges, CHANGES_FILE } = await import('../lib/change.js');
const { buildTimeline } = await import('../lib/timeline.js');

console.log('=== 1. 首次登记：自动建账本 ===');
const a = appendChange({
  object: 'tools-dsh',
  change: '测试：新增改动账本工具',
  evidence: '测试证据：命令 exit 0',
  rollback: '删文件',
  pointer: 'STATUS.md',
});
check(fs.existsSync(CHANGES_FILE), '账本已创建：' + CHANGES_FILE);
check(a.created === true, 'created = true');
check(a.line.startsWith('| 20'), '行以日期开头');
check(a.line.includes('| tools-dsh |'), '对象列写入');
check(a.lineNo >= 5, '返回行号 ' + a.lineNo);

console.log('=== 2. 二次登记：追加不覆盖 ===');
const b = appendChange({ object: 'ego-merged', change: '测试：第二条', evidence: 'e2' });
const rows = listChanges();
check(rows.length === 2, `listChanges 返回 ${rows.length} 条（期望 2）`);
check(rows[1].object === 'ego-merged', '最后一条对象顺序正确');

console.log('=== 3. 管道符转义 ===');
appendChange({ object: 'rules-user', change: 'a | b 含竖线' });
const esc = fs.readFileSync(CHANGES_FILE, 'utf8').split(/\r?\n/).find((l) => l.includes('含竖线'));
check(!!esc && esc.includes('a \\| b'), '竖线被转义，不破坏表格');

console.log('=== 4. STATUS 最后更新戳 ===');
const statusFile = path.join(HOME, 'STATUS-test.md');
fs.writeFileSync(statusFile, '# 测试\n\n> 最后更新：2020-01-01 00:00\n', 'utf8');
const c = appendChange({ object: 'plans', change: '测试：戳 STATUS', status: statusFile });
check(c.status?.ok === true, 'status.ok');
check(!/2020-01-01 00:00/.test(fs.readFileSync(statusFile, 'utf8')), '旧时间戳已被替换');

console.log('=== 5. 时间线合并 CHANGES.md ===');
const tl = buildTimeline();
const fromChanges = tl.events.filter((e) => e.source === 'CHANGES.md');
check(fromChanges.length >= 4, `时间线里来自 CHANGES.md 的事件 ${fromChanges.length} 条（期望 ≥4）`);
check(fromChanges[0].kind === 'change', 'kind = change');
check(fromChanges.some((e) => (e.subject || '').includes('tools-dsh')), '主题包含 tools-dsh');

fs.rmSync(HOME, { recursive: true, force: true });
console.log('');
if (fails.length) { console.log(`结果：${fails.length} 项失败`); process.exit(1); }
console.log('结果：全部通过（已清理 dev/.home-change）');
process.exit(0);
