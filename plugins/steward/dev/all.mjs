/**
 * 统一自测入口（SPEC-决策票据-v1.md §11）：跑全部 dev 冒烟。
 * 用法：node dev/all.mjs
 * 任一子命令非 0 → 整体非 0；输出原样继承，不吞日志。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITES = [
  'smoke.mjs',
  'routes.mjs',
  'card-smoke.mjs',
  'change-smoke.mjs',
  'manage-smoke.mjs',
  'project-smoke.mjs',
  'decisions-smoke.mjs',
  'retro-smoke.mjs',
  'atomic-race.mjs',
];

let failed = 0;
for (const name of SUITES) {
  console.log(`\n===== ${name} =====`);
  const r = spawnSync(process.execPath, [path.join(HERE, name)], { stdio: 'inherit' });
  if (r.status !== 0) {
    failed += 1;
    console.log(`[FAIL] ${name} exit=${r.status ?? r.signal ?? 'unknown'}`);
  }
}
console.log(`\n${failed ? `FAIL: ${failed} 个 suite 未过` : 'ALL SUITES OK'}`);
process.exit(failed ? 1 : 0);
