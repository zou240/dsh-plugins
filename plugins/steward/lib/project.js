/**
 * 项目档案：登记「项目本身」（真源、生成物、冻结件、入口、口径、待办、门禁），
 * 由它生成 / 更新 `STATUS.md`（常驻当前态），收尾时拍一份冻结快照 `HANDOFF-<日期>.md`。
 *
 * 数据：`~/.dsh/projects.json`（只存指针与摘要，正文永远在项目自己的文件里）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DSH, exists, readText, ensureDir } from './core.js';
import { appendChange, listChanges, stamp } from './change.js';
import { listLogs } from './log.js';
import { getPlan, updatePlan, resolvePlan } from './plan.js';

const REG = path.join(DSH, 'projects.json');

/** 写前留一份备份：`~/.dsh/steward/backups/<tag>-<文件名>-<时间戳>.bak`。 */
function backupFile(file, tag) {
  try {
    if (!exists(file)) return null;
    const dir = path.join(DSH, 'koujing', 'backups');
    ensureDir(dir);
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const t = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    const dest = path.join(dir, `${tag}-${path.basename(file)}-${t}.bak`);
    fs.copyFileSync(file, dest);
    return dest;
  } catch {
    return null;
  }
}

/**
 * 读项目表。**坏文件直接抛错**：以前 catch 成空表，下一次写会把整表覆盖掉（2026-11-03 审计 P0-2）。
 * @returns {Record<string, object>}
 */
export function loadProjects() {
  if (!exists(REG)) return {};
  const raw = readText(REG);
  try {
    const j = JSON.parse(raw);
    return j?.projects ?? {};
  } catch (e) {
    throw new Error(
      `~/.dsh/projects.json 解析失败（${e.message}）：拒绝在坏文件上继续写，避免整表被覆盖。` +
        `备份在 ${path.join(DSH, 'koujing', 'backups')}，修好或恢复后重试`,
    );
  }
}

/** 原子写（tmp + rename），写前备份。 */
export function saveProjects(projects) {
  ensureDir(DSH);
  backupFile(REG, 'projects.json');
  const tmp = `${REG}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, projects }, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, REG);
}

/** 文件是不是本插件生成的 STATUS.md（判据：首行「… · 当前态（STATUS）」或生成说明行）。 */
export function isGeneratedStatus(text) {
  const first = String(text ?? '').split(/\r?\n/)[0] ?? '';
  return /·\s*当前态（STATUS）/.test(first) || /由 `steward_handoff status`/.test(String(text ?? ''));
}

/** 写 STATUS 前的目标检查：只认空位或自己生成的 STATUS，绝不覆盖手写文档（2026-11-03 审计 P0-1）。 */
export function assertStatusTarget(file, key = '') {
  if (!file) throw new Error('项目档案没有 statusFile');
  if (!exists(file)) return;
  if (isGeneratedStatus(readText(file))) return;
  throw new Error(
    `拒写：${file} 不是 koujing 生成的 STATUS.md（手写文档不会被覆盖）。` +
      `请改指向 <source>\\STATUS.md（steward_project action=update${key ? ` key=${key}` : ''} statusFile=...）`,
  );
}

export function getProject(key) {
  if (!key) throw new Error('需要项目 key');
  const p = loadProjects()[key];
  if (!p) throw new Error(`没有登记过项目「${key}」，先用 steward_project action=register 登记`);
  return { key, ...p };
}

export function registerProject(rec = {}) {
  const key = String(rec.key ?? '').trim();
  if (!key) throw new Error('需要 key（如 ego）');
  if (!rec.title) throw new Error('需要 title');
  if (!rec.source) throw new Error('需要 source（真源目录）');
  if (!exists(String(rec.source))) throw new Error(`source 不存在或不是目录：${rec.source}`);
  const warnings = [];
  if (rec.plan && !exists(String(rec.plan))) warnings.push(`计划文件不存在：${rec.plan}`);
  const all = loadProjects();
  const prev = all[key] ?? {};
  const statusFile = rec.statusFile !== undefined ? String(rec.statusFile) : prev.statusFile ?? path.join(String(rec.source), 'STATUS.md');
  assertStatusTarget(statusFile, key);
  all[key] = {
    title: String(rec.title),
    source: String(rec.source),
    workspace: rec.workspace ? String(rec.workspace) : prev.workspace ?? path.dirname(String(rec.source)),
    plan: rec.plan !== undefined ? String(rec.plan) : prev.plan ?? '',
    ledgerKeys: rec.ledgerKeys ?? prev.ledgerKeys ?? [],
    statusFile,
    handoffDir: rec.handoffDir !== undefined ? String(rec.handoffDir) : prev.handoffDir ?? String(rec.source),
    gate: rec.gate !== undefined ? String(rec.gate) : prev.gate ?? '',
    entry: rec.entry ?? prev.entry ?? [],
    rules: rec.rules ?? prev.rules ?? [],
    outputs: rec.outputs ?? prev.outputs ?? [],
    frozen: rec.frozen ?? prev.frozen ?? [],
    todo: rec.todo ?? prev.todo ?? [],
    status: rec.status ?? prev.status ?? 'active',
    closedAt: rec.closedAt ?? prev.closedAt ?? '',
    created: prev.created ?? stamp(),
    updated: stamp(),
  };
  saveProjects(all);
  return { key, project: all[key], file: REG, warnings };
}

/** 可经 updateProject 改的字段（拼错字段名不许静默写入，2026-11-03 审计 P1-4）。 */
const UPDATABLE = [
  'title', 'source', 'workspace', 'plan', 'ledgerKeys', 'statusFile', 'handoffDir',
  'gate', 'entry', 'rules', 'outputs', 'frozen', 'todo', 'status', 'closedAt', 'updated',
];

export function updateProject(key, patch = {}) {
  const unknown = Object.keys(patch).filter((k) => !UPDATABLE.includes(k));
  if (unknown.length) {
    throw new Error(`updateProject 不认字段：${unknown.join(', ')}（可改：${UPDATABLE.join(', ')}）`);
  }
  const all = loadProjects();
  if (!all[key]) throw new Error(`没有登记过项目「${key}」`);
  if (patch.statusFile !== undefined) assertStatusTarget(String(patch.statusFile), key);
  if (patch.source !== undefined && !exists(String(patch.source))) {
    throw new Error(`source 不存在或不是目录：${patch.source}`);
  }
  if (patch.status !== undefined && !['active', 'paused', 'done'].includes(String(patch.status))) {
    throw new Error(`status 只能是 active / paused / done（收到：${patch.status}）`);
  }
  const next = { ...all[key], ...patch, updated: stamp() };
  // status=active 即 reopen：清掉收尾时间，否则 STATUS 仍被判冻结（2026-11-03 审计 P1-2）
  if (patch.status === 'active') delete next.closedAt;
  all[key] = next;
  saveProjects(all);
  return { key, project: all[key], file: REG };
}

const bullet = (s) => `- ${s}`;

/** 项目健康度：档案里的指针现在还指不指得到东西（list / STATUS 都靠它）。 */
export function healthOf(p) {
  const sourceOk = !!p.source && exists(String(p.source));
  const statusState = !p.statusFile
    ? 'none'
    : !exists(p.statusFile)
      ? 'missing'
      : isGeneratedStatus(readText(p.statusFile))
        ? 'generated'
        : 'foreign';
  let planOk = null;
  if (p.plan) {
    try {
      planOk = exists(resolvePlan(p.plan));
    } catch {
      planOk = false;
    }
  }
  return { sourceOk, statusState, planOk, closed: !!p.closedAt, gate: !!p.gate };
}

/** 删掉一条项目档案（只删档案，不动项目文件）。 */
export function removeProject(key) {
  const all = loadProjects();
  if (!all[key]) throw new Error(`没有登记过项目「${key}」`);
  const prev = all[key];
  delete all[key];
  saveProjects(all);
  return { key, file: REG, removed: prev };
}

function planBlock(p) {
  if (!p.plan) return ['（未指定计划文件）'];
  try {
    const r = getPlan(p.plan);
    const steps = r.parsed?.steps ?? [];
    const done = steps.filter((s) => s.done).length;
    const L = [`计划：${r.file}（${done}/${steps.length}，status=${r.parsed?.status ?? '?'}）`, ''];
    for (const s of steps) L.push(`- [${s.done ? 'x' : ' '}] ${s.text}`);
    return L;
  } catch (e) {
    return [`（读不到计划：${e.message}）`];
  }
}

function changesBlock(p, limit = 8) {
  // 项目 key 与账本「对象」key 曾是两套命名空间（ego vs ego-merged），别名数组一并匹配（2026-11-03 审计 P1-1）
  const keys = [p.key, ...(Array.isArray(p.ledgerKeys) ? p.ledgerKeys : [])].filter(Boolean).map(String);
  const rows = listChanges(0)
    .filter((r) => String(r.object).split(/[\s,;、]+/).some((o) => keys.includes(o)))
    .slice(-limit);
  if (!rows.length) return [`（账本里还没有这个项目的记录；对象列写 ${keys.join(' / ')} 任一即可）`];
  return rows.map(
    (r) => `- ${r.at} [${r.type}] ${r.change}${r.evidence ? `（证据：${String(r.evidence).slice(0, 90)}）` : ''}`,
  );
}

function logsBlock(key, limit = 5) {
  const rows = listLogs(key, limit);
  if (!rows.length) return ['（还没有过程日志）'];
  return rows.map((r) => `- ${r.at} [${r.type}] ${String(r.text).split('\n')[0].slice(0, 120)}`);
}

function listBlock(items, fmt = (x) => x) {
  return items?.length ? items.map((x) => bullet(fmt(x))) : ['（未填）'];
}

/** 渲染 STATUS 正文（当前态）。 */
export function renderStatus(p, { closed = false, closedAt = '' } = {}) {
  const L = [];
  L.push(`# ${p.title} · 当前态（STATUS）`);
  L.push('');
  L.push(`> 最后更新：${p.updated || stamp()}　·　由 \`steward_handoff status\` 从项目档案 + 计划 + 改动账本 + 日志生成`);
  if (closed) L.push(`> **已收尾 ${closedAt}**：本文件不再更新，冻结快照见同目录 \`HANDOFF-${String(closedAt).slice(0, 10)}.md\``);
  L.push('');
  L.push('## 一、真源与生成物');
  L.push('');
  L.push(`- 真源（唯一可改）：\`${p.source}\``);
  const outputs = (p.outputs ?? []).map((o) => `生成物 · ${o.name}：\`${o.path}\`${o.note ? `（${o.note}）` : ''}`);
  const frozen = (p.frozen ?? []).map((o) => `冻结 · ${o.name}：\`${o.path}\`${o.note ? `（${o.note}）` : ''}`);
  if (outputs.length || frozen.length) L.push(...outputs.map(bullet), ...frozen.map(bullet));
  else L.push('（未填）');
  L.push('');
  L.push('## 二、入口');
  L.push('');
  L.push(...listBlock(p.entry));
  L.push('');
  L.push('## 三、口径（改之前先看）');
  L.push('');
  L.push(...listBlock(p.rules));
  L.push('');
  L.push('## 四、计划进度');
  L.push('');
  L.push(...planBlock(p));
  L.push('');
  L.push('## 五、最近改动（来自 ~/.dsh/CHANGES.md）');
  L.push('');
  L.push(...changesBlock(p));
  L.push('');
  L.push('## 六、过程日志（最近 5 条）');
  L.push('');
  L.push(...logsBlock(p.key));
  L.push('');
  L.push('## 七、待办 / 未拍口径');
  L.push('');
  L.push(...listBlock(p.todo));
  L.push('');
  L.push('## 八、历史指针');
  L.push('');
  L.push(`- 改动账本：\`${path.join(DSH, 'CHANGES.md')}\``);
  L.push(`- 项目日志：\`${path.join(DSH, 'logs', `${p.key}.md`)}\``);
  // 时间线发在工作区根目录，不是 ~/.dsh（2026-11-03 修：3 份 STATUS 都指到不存在的 ~/.dsh/TIMELINE.md）
  const wsRoot = p.workspace || (p.plan ? path.dirname(String(p.plan)) : DSH);
  L.push(`- 时间线：\`${path.join(wsRoot, 'TIMELINE.md')}\`（\`steward_timeline publish\`）`);
  if (p.plan) L.push(`- 计划：\`${p.plan}\``);
  if (p.gate) L.push(`- 门禁：\`${p.gate}\``);
  L.push('');
  return L.join('\n');
}

/** 写 / 覆盖 STATUS.md（只写自己生成的文件；已收尾拒绝复活；写前备份）。 */
export function writeStatus(p) {
  const file = p.statusFile;
  if (p.closedAt) {
    throw new Error(
      `项目 ${p.key} 已于 ${p.closedAt} 收尾：STATUS 冻结，不再重写。要改先 reopen：steward_project action=update key=${p.key} status=active`,
    );
  }
  assertStatusTarget(file, p.key);
  ensureDir(path.dirname(file));
  const backup = backupFile(file, 'STATUS');
  // 时间戳取「现在」并回写档案：否则 STATUS 里写的是上次登记时间，与文件 mtime 对不上（门禁会判过期）
  const key = p.key;
  const at = stamp();
  const fresh = { ...p, updated: at };
  if (key) {
    try {
      const all = loadProjects();
      if (all[key]) {
        all[key] = { ...all[key], updated: at };
        saveProjects(all);
      }
    } catch {
      /* 档案写不了不影响 STATUS 生成 */
    }
  }
  const text = renderStatus(fresh);
  fs.writeFileSync(file, text, 'utf8');
  return { file, at, text, backup };
}

/** 收尾：冻结 HANDOFF 快照 + STATUS 标已收尾 + 计划标 done + 写一行账本。 */
export function closeProject(key, { note = '', planDone = true } = {}) {
  const p = getProject(key);
  const at = stamp();
  const day = at.slice(0, 10);
  const dir = p.handoffDir || path.dirname(p.statusFile);
  ensureDir(dir);
  // 同日二次收尾不许覆盖已冻结的快照（2026-11-03 审计 P0-3）：已存在则 -2、-3 递增
  let handoff = path.join(dir, `HANDOFF-${day}.md`);
  for (let i = 2; exists(handoff); i += 1) handoff = path.join(dir, `HANDOFF-${day}-${i}.md`);
  // 指针带目录：handoffDir 与 statusFile 不同目录时（如 hud），只写文件名指不到（审计 P2-8）
  const handoffLabel = path.dirname(p.statusFile) === dir ? path.basename(handoff) : handoff;

  const head = [`# ${p.title} · 收尾交接（${day}）`, '', `> 由 \`steward_handoff close\` 在 ${at} 生成；冻结快照，不再修改。`];
  if (note) head.push('', `> 收尾说明：${note}`);
  const body = renderStatus(p, { closed: true, closedAt: at });
  fs.writeFileSync(handoff, [...head, '', body].join('\n'), 'utf8');

  // STATUS 顶部标已收尾
  if (exists(p.statusFile)) {
    const old = readText(p.statusFile);
    if (!/已收尾/.test(old.split('\n').slice(0, 8).join('\n'))) {
      const lines = old.split(/\r?\n/);
      lines.splice(2, 0, '', `> **已收尾 ${at}**：冻结快照见 \`${handoffLabel}\`（本文件不再更新）`);
      fs.writeFileSync(p.statusFile, lines.join('\n'), 'utf8');
    }
  }

  let plan = null;
  if (planDone && p.plan) {
    try {
      plan = updatePlan({ ref: p.plan, status: 'done', progress: `${at} 收尾：冻结交接 ${handoff}` });
    } catch (e) {
      plan = { error: e.message };
    }
  }

  const change = appendChange({
    object: key,
    type: '决策',
    change: `项目收尾：冻结交接快照 HANDOFF-${day}.md${plan && !plan.error ? '，计划标 done' : ''}`,
    evidence: handoff,
    rollback: '删快照并把 STATUS 顶部「已收尾」行去掉、计划 status 改回 active',
    pointer: p.statusFile,
  });

  updateProject(key, { status: 'done', closedAt: at, updated: at });
  return { handoff, statusFile: p.statusFile, plan, change };
}
