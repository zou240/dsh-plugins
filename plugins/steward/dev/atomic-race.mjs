/**
 * 原子写冒烟：多个进程同时 save 同一份 PLAN，产出必须是完整可解析的一份，
 * 且目录里不残留 .tmp-* 半成品（批次 1 的 tmp+rename 验收）。
 * 用法：node dev/atomic-race.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WS = path.join(HERE, '.race-ws');
const HOME = path.join(HERE, '.race-home');
const CHILD = path.join(HERE, '.race-child.mjs');
const PROCS = 3;
const LOOPS = 25;

fs.rmSync(WS, { recursive: true, force: true });
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(path.join(HOME, '.dsh', 'storages'), { recursive: true });
fs.mkdirSync(WS, { recursive: true });
fs.writeFileSync(
  CHILD,
  [
    "import { savePlan } from '../lib/plan.js';",
    'const [ws, id] = process.argv.slice(2);',
    `for (let i = 0; i < ${LOOPS}; i += 1) {`,
    "  savePlan({ workspace: ws, title: 'race', goal: 'g' + id + '-' + i, scope: 's', steps: ['a', 'b', 'c'], accept: 'a', risks: 'r' });",
    '}',
    '',
  ].join('\n'),
  'utf8',
);

const run = (id) =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, [CHILD, WS, String(id)], {
      env: { ...process.env, KOUJING_HOME: HOME, KOUJING_ISOLATED: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    p.stderr.on('data', (d) => (err += String(d)));
    p.on('exit', (code) => resolve({ code: code ?? -1, err }));
    p.on('error', (e) => resolve({ code: -1, err: String(e) }));
  });

const results = await Promise.all(Array.from({ length: PROCS }, (_, i) => run(i)));
const codes = results.map((r) => r.code);
for (const r of results) if (r.err) console.error(r.err.split('\n').slice(0, 8).join('\n'));
const { parsePlan } = await import('../lib/plan.js');
const file = path.join(WS, 'PLAN-race.md');
const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const parsed = text ? parsePlan(text) : null;
const tmpLeft = fs.readdirSync(WS).filter((n) => /\.tmp-\d+-\d+$/.test(n));
const out = [];
const ok = (name, cond, extra = '') => out.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`);

ok(`${PROCS} 个进程 × ${LOOPS} 次 save 全部退出 0`, codes.every((c) => c === 0), codes.join(','));
ok('文件存在且能完整解析', Boolean(parsed) && parsed.steps.length === 3 && parsed.risks === 'r' && parsed.goal.startsWith('g'), parsed ? parsed.goal : '无文件');
ok('六个必填节都在', Boolean(parsed) && ['目标', '范围', '步骤', '验收', '风险 / 回滚', '进度记录'].every((h) => text.includes(`## ${h}`)));
ok('没有残留 .tmp-* 半成品', tmpLeft.length === 0, tmpLeft.join(',') || '无');

fs.rmSync(CHILD, { force: true });
fs.rmSync(WS, { recursive: true, force: true });
fs.rmSync(HOME, { recursive: true, force: true });

console.log(out.join('\n'));
process.exit(out.some((l) => l.startsWith('FAIL')) ? 1 : 0);
