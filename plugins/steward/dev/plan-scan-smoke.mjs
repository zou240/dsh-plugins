// 冒烟：listPlans 扫工作区根 / docs\_common / docs\<主题> / projects.json 项目目录
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = path.join(os.tmpdir(), 'steward-plan-scan-smoke');
fs.rmSync(TMP, { recursive: true, force: true });
const DSH = path.join(TMP, '.dsh');
const WS = path.join(TMP, 'ws');
const PROJ = path.join(TMP, 'proj');
for (const d of [path.join(DSH, 'storages'), path.join(WS, 'docs', '_common'), path.join(WS, 'docs', '主题A'), PROJ]) {
  fs.mkdirSync(d, { recursive: true });
}
fs.writeFileSync(
  path.join(DSH, 'storages', 'workspace.json'),
  JSON.stringify({ tables: { workspaces: { w1: { title: 'WS', path: WS } } } }),
);
const plan = (t) => `---\ntitle: ${t}\nstatus: active\ncreated: 2026-11-21\nupdated: 2026-11-21\n---\n\n# ${t}\n\n## 目标\n\n冒烟\n`;
fs.writeFileSync(path.join(WS, 'PLAN-根计划.md'), plan('根计划'));
fs.writeFileSync(path.join(WS, 'docs', '_common', 'PLAN-通用计划.md'), plan('通用计划'));
fs.writeFileSync(path.join(WS, 'docs', '主题A', 'PLAN-主题计划.md'), plan('主题计划'));
fs.writeFileSync(path.join(PROJ, 'PLAN-项目计划.md'), plan('项目计划'));
fs.writeFileSync(
  path.join(DSH, 'projects.json'),
  JSON.stringify({
    version: 1,
    projects: { demo: { source: PROJ, workspace: WS, plan: path.join(PROJ, 'PLAN-项目计划.md') } },
  }),
);

process.env.KOUJING_HOME = TMP;
process.env.KOUJING_ISOLATED = '1';
const { listPlans } = await import('file:///D:/dsh/dsh-plugins/plugins/steward/lib/plan.js');
const rows = listPlans();
const got = rows.map((r) => r.title).sort();
const want = ['根计划', '通用计划', '主题计划', '项目计划'].sort();
console.log(rows.map((r) => `${r.title}  @ ${r.file}`).join('\n'));
const ok = JSON.stringify(got) === JSON.stringify(want);
console.log(ok ? 'PASS 4/4' : `FAIL 期望 ${want.join(',')} 实得 ${got.join(',')}`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
