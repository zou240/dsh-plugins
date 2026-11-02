/**
 * 时间线：把以往记录串起来。
 *
 * 来源（全部本机、只读）：
 *   - plugin-registry-details.md 的 D7 修改历史 / D8 报错记录
 *   - 各工作区的 PLAN-*.md
 *   - 规则台账 ledger.json
 *   - 改动账本 ~/.dsh/CHANGES.md（2026-11-03 起：跨会话的「改了什么」都在这里）
 *
 * 输出：事件数组（按日期升序）+ 主题线（把同一件事的多条串成一条线）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DSH, exists, ledgerReport, readText } from './core.js';
import { listChanges } from './change.js';
import { allLogs } from './log.js';
import { listPlans } from './plan.js';

const DETAILS = path.join(DSH, 'plugin-registry-details.md');

/** 取某个二级标题下的表格数据行（跳过分隔行）。 */
export function parseTable(text, heading) {
  const lines = String(text ?? '').split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === heading.trim());
  if (start < 0) return [];
  const rows = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^##\s+/.test(line)) break;
    if (!line.trim().startsWith('|')) continue;
    if (/^\|[\s:|-]+\|$/.test(line.trim())) continue;
    const cells = line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim().replace(/\\\|/g, '|'));
    if (!cells.length) continue;
    rows.push(cells);
  }
  return rows;
}

const DOMAINS_FILE = path.join(DSH, 'koujing', 'domains.json');

// 主题线默认值保持中性；个人 / 团队的主题线可在 ~/.dsh/steward/domains.json 的 threads 里覆盖。
const DEFAULT_THREADS = [
  { id: 'docs', name: '文档与规则', re: /文档|手册|索引|规则|lint|门禁/i },
  { id: 'tools', name: '工具与插件', re: /插件|工具|profile|bundle|脚本|cli/i },
  { id: 'plan', name: '计划与流程', re: /计划|流程|步骤|runbook|排期/i },
  { id: 'stability', name: '稳定性', re: /崩溃|报错|失败|超时|中断|回滚/ },
  { id: 'env', name: '环境与服务', re: /环境|设备|端口|服务|依赖|版本/ },
];

function loadThreads() {
  try {
    const j = JSON.parse(readText(DOMAINS_FILE));
    const list = Array.isArray(j?.threads) ? j.threads : [];
    const out = list
      .filter((t) => t && t.name && t.pattern)
      .map((t) => ({
        id: String(t.id ?? t.name),
        name: String(t.name),
        re: new RegExp(String(t.pattern), String(t.flags ?? 'i')),
      }));
    return out.length ? out : DEFAULT_THREADS;
  } catch {
    return DEFAULT_THREADS;
  }
}

function threadOf(event) {
  const hay = `${event.title} ${event.detail} ${event.why}`.replace(/（系统层，无插件改动）|\(系统层，无插件改动\)/g, '');
  const hit = loadThreads().find((t) => t.re.test(hay));
  return hit ?? { id: 'misc', name: '其他', re: null };
}

const clip = (s, n = 160) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** 去掉 markdown 强调标记，避免截断后出现半个 `**`。 */
const clean = (s) => String(s ?? '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();

const BOILER = /系统层，无插件改动|工具，非插件/;

function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function buildTimeline() {
  const events = [];
  const details = exists(DETAILS) ? readText(DETAILS) : '';

  for (const r of parseTable(details, '## D7 修改历史')) {
    const [date, plugin, version, what, why, evidence, rollback] = r;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const subject = BOILER.test(plugin ?? '') ? '' : `${clean(plugin)}${version && version !== '—' ? ` ${clean(version)}` : ''}`;
    const fact = clean(what);
    events.push({
      at: date,
      kind: 'change',
      subject,
      title: clip(fact, 56),
      detail: clip(fact, 600),
      why: clip(clean(why), 300),
      evidence: clip(clean(evidence), 300),
      rollback: clip(clean(rollback), 240),
      source: 'plugin-registry D7',
    });
  }

  for (const r of parseTable(details, '## D8 报错记录')) {
    const [date, component, symptom, trigger, conclusion] = r;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    events.push({
      at: date,
      kind: 'error',
      subject: clean(component),
      title: clip(clean(symptom), 56),
      detail: clip(clean(symptom), 400),
      why: `触发条件：${clip(clean(trigger), 200)}`,
      evidence: `结论：${clip(clean(conclusion), 240)}`,
      rollback: '',
      source: 'plugin-registry D8',
    });
  }

  for (const p of listPlans()) {
    events.push({
      at: (p.updated || '').slice(0, 10) || p.updated,
      kind: 'plan',
      subject: '',
      title: `计划 · ${p.title}（${p.doneSteps}/${p.steps}）`,
      detail: clip(clean(p.goal), 240),
      why: '项目计划文件，随时可读',
      evidence: p.file,
      rollback: '',
      source: 'PLAN',
    });
  }

  // 改动账本：跨会话「改了什么」的唯一来源，按行并入
  for (const c of listChanges(500)) {
    const at = String(c.at ?? '').slice(0, 10);
    if (!at) continue;
    events.push({
      at,
      kind: 'change',
      subject: clean(c.object),
      title: clip(clean(c.change), 56),
      detail: clip(clean(c.change), 600),
      why: '',
      evidence: clip(clean(c.evidence), 300),
      rollback: clip(clean(c.rollback), 240),
      source: 'CHANGES.md',
    });
  }

  // 项目过程日志：块状记录按时间并入（报错类标成 error）
  for (const l of allLogs(300)) {
    if (!l.at) continue;
    events.push({
      at: String(l.at).slice(0, 10),
      kind: l.type === '报错' ? 'error' : 'change',
      subject: clean(l.project),
      title: clip(clean(l.text), 56),
      detail: clip(clean(l.text), 600),
      why: '',
      evidence: '',
      rollback: '',
      source: 'logs',
    });
  }

  // 规则台账按「文件」聚成一条，避免几十条规定淹没真正的改动
  const ledgerRows = ledgerReport();
  const byFile = new Map();
  for (const r of ledgerRows) {
    const k = String(r.file ?? '(未知)');
    if (!byFile.has(k)) byFile.set(k, []);
    byFile.get(k).push(r);
  }
  for (const [file, rows] of byFile) {
    const dates = rows.map((r) => String(r.at ?? '').slice(0, 10)).filter(Boolean).sort();
    const stale = rows.filter((r) => r.found === false).length;
    const where = rows[0]?.scope === 'user'
      ? '用户级 AGENTS.md'
      : `${path.basename(path.dirname(file))}\\AGENTS.md`;
    events.push({
      at: dates[dates.length - 1],
      kind: 'rule',
      subject: '',
      title: `规则台账 · ${where} 登记 ${rows.length} 条${stale ? `（${stale} 条失效）` : ''}`,
      detail: clip(rows.map((r) => r.title).join(' / '), 300),
      why: '规定总表；逐条查用 steward_ledger，细则正文在各自的 AGENTS.md',
      evidence: `${file} · 台账 ~/.dsh/steward/ledger.json`,
      rollback: '',
      source: '规则台账',
    });
  }

  const sorted = events
    .filter((e) => e.at)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));

  const threads = loadThreads().map((t) => ({
    id: t.id,
    name: t.name,
    count: 0,
    first: null,
    last: null,
    items: [],
  }));
  threads.push({ id: 'misc', name: '其他', count: 0, first: null, last: null, items: [] });

  for (const e of sorted) {
    const t = threads.find((x) => x.id === threadOf(e).id);
    t.count += 1;
    t.first = t.first ?? e.at;
    t.last = e.at;
    t.items.push({ at: e.at, title: e.title, subject: e.subject ?? '', kind: e.kind });
  }

  return {
    generatedAt: localStamp(),
    range: { from: sorted[0]?.at ?? null, to: sorted[sorted.length - 1]?.at ?? null },
    total: sorted.length,
    threads: threads.filter((t) => t.count > 0),
    events: sorted,
  };
}

export function renderTimelineMarkdown(tl = buildTimeline()) {
  const L = [];
  L.push(`# 时间线：${tl.range.from ?? '—'} → ${tl.range.to ?? '—'} 的本机改动`);
  L.push('');
  L.push(`> 生成于 ${tl.generatedAt} · 共 ${tl.total} 条 · 范围 ${tl.range.from ?? '—'} → ${tl.range.to ?? '—'}`);
  L.push('> 来源：`plugin-registry-details.md` 的 D7 修改历史 / D8 报错记录、各工作区 `PLAN-*.md`、规则台账、改动账本 `~/.dsh/CHANGES.md`。本文件由 `steward_timeline` 生成，重跑会覆盖。');
  L.push('');
  L.push('## 主线');
  L.push('');
  for (const t of tl.threads) {
    const names = t.items
      .slice(-3)
      .map((i) => `${i.subject ? `${i.subject} · ` : ''}${i.title}`)
      .join(' → ');
    L.push(`- **${t.name}**（${t.count} 条，${t.first} → ${t.last}）：${clip(names, 180)}`);
  }
  L.push('');
  L.push('## 逐日记录');
  L.push('');

  let day = '';
  for (const e of tl.events) {
    if (e.at !== day) {
      day = e.at;
      if (L.length && L[L.length - 1] !== '') L.push('');
      L.push(`### ${day}`);
      L.push('');
    }
    L.push(`- **${e.kind === 'error' ? '⚠ ' : ''}${e.subject ? `${e.subject} · ` : ''}${e.title}**`);
    if (e.detail && e.detail !== e.title) L.push(`  - 事实：${e.detail}`);
    if (e.why) L.push(`  - 为什么：${e.why}`);
    if (e.evidence) L.push(`  - 证据：${e.evidence}`);
    if (e.rollback) L.push(`  - 回滚：${e.rollback}`);
    L.push(`  - 来源：${e.source}`);
  }
  L.push('');
  return L.join('\n');
}

export function publishTimeline(workspace) {
  const tl = buildTimeline();
  const file = path.join(workspace, 'TIMELINE.md');
  fs.writeFileSync(file, renderTimelineMarkdown(tl), 'utf8');
  return { file, total: tl.total, range: tl.range };
}
