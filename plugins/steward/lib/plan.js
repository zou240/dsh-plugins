/**
 * 项目计划：存到工作区根目录的 PLAN-<名字>.md，模型随时可读、用户可直接打开。
 *
 * 文件结构（固定，便于机器解析）：
 *   ---
 *   title / status / created / updated / workspace
 *   ---
 *   # 标题
 *   ## 目标
 *   ## 范围
 *   ## 步骤            - [ ] / - [x]
 *   ## 并行 / 工作树    （按需）
 *   ## 验收
 *   ## 风险 / 回滚
 *   ## 进度记录        - DATE 内容
 *
 * 更新语义（save 的 mode，2026-10-31 加）：
 *   merge（默认）  未传的节保留；传了的节整段替换；steps 按「精确相等」并入，未传的旧步骤与勾选不动
 *   append         未传的节保留；传了的节追加到该节末尾（已含则跳过）；steps 只追加，不改已有文案
 *   replace        整篇重写：未传的必填节填「（待补）」，按需节删除，手写小节丢弃（并报告丢了哪些）
 *
 * 任何模式下：进度记录永不被 save 清空（只有 update 会追加）；认不出的手写小节在 merge/append 下原样保留到文末。
 *
 * 格式进化解耦（2026-11-07 批次 1 决策）：节模型（SECTIONS）就在本文件里，
 * 不引入独立的 `plan-format` 包或格式版本号——本仓外没有消费者，拆包只会多一条加载路径和一个版本面；
 * 等真出现外部消费者（别的插件 / 脚本要读 PLAN）再抽。
 */
import fs from 'node:fs';
import path from 'node:path';
import { exists, workspaces } from './core.js';
import {
  parseDecisions,
  renderDecisions,
  decisionCounts,
  firstTickets,
  PENDING_STATUSES,
  DECISION_CODE_ORDER,
  duplicateTicketIds,
  addTicket,
  claimTicket,
  resolveTicket,
} from './decisions.js';

const PLAN_RE = /^PLAN-(.+)\.md$/i;
const MODES = ['merge', 'append', 'replace'];

export function slugify(title) {
  const s = String(title ?? '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return (s || `plan-${Date.now()}`).slice(0, 40);
}

function stampDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function stampTime(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${stampDate(d)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 原子写：同目录临时文件 + rename，避免并发 save 留下半截 PLAN（批次 1）。
 *  Windows 上 rename 覆盖正被另一进程读的目标会短暂 EPERM/EBUSY，退避重试几次再报错。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, 'utf8');
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      lastErr = e;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || attempt === 5) break;
      sleepSync(10 * (attempt + 1));
    }
  }
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* rename 已成功时 tmp 不存在，忽略 */
  }
  throw lastErr;
}

function splitFrontmatter(text) {
  // 带 BOM 的文件（编辑器另存常见）也按正常 frontmatter 解析，否则 meta 全丢、status 回落 active
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { meta: {}, body: src };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]] = kv[2];
  }
  return { meta, body: src.slice(m[0].length) };
}

/** 二级标题名 → 规范键；认不出返回 null（= 手写小节） */
const NAME_TO_KEY = {
  目标: 'goal',
  差距对照: 'gap',
  决策票据: 'decisions',
  范围: 'scope',
  步骤: 'steps',
  '并行 / 工作树': 'parallel',
  '并行/工作树': 'parallel',
  并行与工作树: 'parallel',
  执行档位: 'modes',
  验收: 'accept',
  '风险 / 回滚': 'risks',
  '风险/回滚': 'risks',
  风险回滚: 'risks', // scaffoldPlan 曾写这种（无分隔），不归一就会掉进 extras 并在下次 merge 重复

  进度记录: 'progress',
};

function keyOf(name) {
  const n = String(name ?? '').trim();
  if (Object.prototype.hasOwnProperty.call(NAME_TO_KEY, n)) return NAME_TO_KEY[n];
  const loose = n.replace(/\s+/g, '');
  for (const [k, v] of Object.entries(NAME_TO_KEY)) {
    if (k.replace(/\s+/g, '') === loose) return v;
  }
  return null;
}

/** 唯一的节模型：顺序 = 渲染顺序。
 *  parse / render / save / update / audit / scaffold 全部从这里派生，避免六套写法各自漂移。
 *  required = audit 必填 + replace 填空；optional = 只在调用方给值（含空串）时出现。
 *  short = audit 报错里用的显示名（`风险 / 回滚` 报成「风险」）。 */
const SECTIONS = [
  { key: 'goal', name: '目标', required: true },
  { key: 'gap', name: '差距对照', optional: true },
  { key: 'scope', name: '范围', required: true },
  { key: 'decisions', name: '决策票据', optional: true, special: true },
  { key: 'steps', name: '步骤', required: true },
  { key: 'parallel', name: '并行 / 工作树', optional: true },
  { key: 'modes', name: '执行档位', optional: true },
  { key: 'accept', name: '验收', required: true },
  { key: 'risks', name: '风险 / 回滚', required: true, short: '风险' },
  { key: 'progress', name: '进度记录', required: true, short: '进度' },
];
const SECTION_BY_KEY = Object.fromEntries(SECTIONS.map((s) => [s.key, s]));
/** save 会写回的节（步骤单独走 mergeSteps，进度只由 update 追加，决策票据单独走六形态） */
const SAVE_KEYS = SECTIONS.filter((s) => !s.special && s.key !== 'steps' && s.key !== 'progress').map((s) => s.key);

/** 按 key 取首个同名节的正文；没出现就不在 map 里（区分「没写」与「写空了」） */
function sectionsByKey(body) {
  const byKey = {};
  for (const s of parseSections(body)) if (s.key && !(s.key in byKey)) byKey[s.key] = s.text;
  return byKey;
}

/** 按二级标题切节，保留顺序与原文（手写小节也在里面）。
 *  代码围栏（``` / ~~~）里的 `##` 不算节——夹具与老计划里出现过围栏，不能被它切坏。 */
export function parseSections(body) {
  const src = String(body ?? '');
  const heads = [];
  let fence = false;
  let pos = 0;
  for (const line of src.split(/(?<=\n)/)) {
    const bare = line.replace(/\r?\n$/, '');
    if (/^\s*(```|~~~)/.test(bare)) fence = !fence;
    else if (!fence) {
      const m = /^##\s+(.+?)\s*$/.exec(bare);
      if (m) heads.push({ name: m[1].trim(), lineStart: pos, start: pos + line.length });
    }
    pos += line.length;
  }
  const out = [];
  for (let i = 0; i < heads.length; i += 1) {
    const end = i + 1 < heads.length ? heads[i + 1].lineStart : src.length;
    const text = src.slice(heads[i].start, end).replace(/^\r?\n/, '').replace(/\s+$/, '');
    // lineStart = 标题行起点；bodyStart = 标题行之后（正文字节起点）；end = 下一个标题行起点 / 文末
    out.push({ name: heads[i].name, key: keyOf(heads[i].name), text, lineStart: heads[i].lineStart, bodyStart: heads[i].start, end });
  }
  return out;
}

function section(body, name) {
  const hit = parseSections(body).find((s) => s.name.replace(/\s+/g, '') === String(name).replace(/\s+/g, ''));
  return hit ?? null;
}

export function parsePlan(text) {
  const { meta, body } = splitFrontmatter(text);
  const titleLine = /^#\s+(.+)$/m.exec(body);
  const secs = parseSections(body);
  const byKey = sectionsByKey(body);
  const steps = [];
  if (byKey.steps !== undefined) {
    for (const line of byKey.steps.split(/\r?\n/)) {
      const m = /^\s*-\s*\[([ xX])\]\s*(.+)$/.exec(line);
      if (m) steps.push({ done: m[1].toLowerCase() === 'x', text: m[2].trim().replace(/^\d+\.\s*/, '') });
    }
  }
  const out = {
    meta,
    title: titleLine?.[1]?.trim() || meta.title || '',
    status: meta.status || 'active',
  };
  // 必填节缺失 → ''；按需节缺失 → undefined（save 靠这个区分「没写」和「写空了」）
  for (const s of SECTIONS) {
    if (s.special) continue;
    out[s.key] = s.optional ? (s.key in byKey ? byKey[s.key] : undefined) : (byKey[s.key] ?? '');
  }
  // 决策票据：节存在才给 parsed.decisions（{tickets, frontier, issues}），无节时键整体不存在
  if ('decisions' in byKey) out.decisions = parseDecisions(byKey.decisions);
  out.steps = steps;
  out.extras = secs.filter((s) => !s.key).map((s) => ({ name: s.name, text: s.text }));
  return out;
}

export function planFiles(ws) {
  try {
    return fs
      .readdirSync(ws)
      .filter((n) => PLAN_RE.test(n))
      .map((n) => path.join(ws, n));
  } catch {
    return [];
  }
}

export function listPlans() {
  const out = [];
  for (const w of workspaces()) {
    for (const file of planFiles(w.path)) {
      try {
        const p = parsePlan(fs.readFileSync(file, 'utf8'));
        out.push({
          file,
          workspace: w.path,
          title: p.title || path.basename(file, '.md'),
          status: p.status,
          updated: p.meta.updated || '',
          steps: p.steps.length,
          doneSteps: p.steps.filter((s) => s.done).length,
          goal: p.goal.split(/\r?\n/)[0] ?? '',
        });
      } catch {
        /* 跳过坏文件 */
      }
    }
  }
  return out.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
}

export function resolvePlan(ref) {
  const r = String(ref ?? '').trim();
  if (!r) throw new Error('需要 plan 参数：绝对路径，或计划名（PLAN-xxx.md / xxx）');
  if (exists(r)) return r;
  const base = r.toLowerCase().replace(/^plan-/, '').replace(/\.md$/, '');
  const hit = listPlans().find((p) => {
    const name = path.basename(p.file, '.md').toLowerCase().replace(/^plan-/, '');
    return name === base || p.title.toLowerCase() === r.toLowerCase();
  });
  if (hit) return hit.file;
  const fuzzy = listPlans().find((p) => p.title.toLowerCase().includes(base) || p.file.toLowerCase().includes(base));
  if (fuzzy) return fuzzy.file;
  throw new Error(`没找到计划：${r}。可用 steward_plan list 看现有计划`);
}

function render({ title, goal, gap, scope, decisionsText, steps, parallel, modes, accept, risks, status, created, progress, isNew, extras }) {
  const now = stampDate();
  const L = [
    '---',
    `title: ${title}`,
    `status: ${status || 'active'}`,
    `created: ${created || now}`,
    `updated: ${now}`,
    '---',
    '',
    `# ${title}`,
    '',
  ];
  // 每个节只给「怎么渲染正文」；节名与顺序全由 SECTIONS 决定，加节不用改这里
  const bodies = {
    goal: () => (goal ? String(goal).trim() : '（待补）'),
    gap: () => (gap !== undefined ? (gap ? String(gap).trim() : '（待补）') : null),
    scope: () => (scope ? String(scope).trim() : '- 做：\n- 不做：'),
    steps: () =>
      steps && steps.length
        ? steps.map((s, i) => `- [${s.done ? 'x' : ' '}] ${i + 1}. ${s.text}`)
        : ['- [ ] 1. （待补）'],
    parallel: () => (parallel !== undefined ? (parallel ? String(parallel).trim() : '（待补）') : null),
    modes: () => (modes !== undefined ? (modes ? String(modes).trim() : '（待补）') : null),
    accept: () => (accept ? String(accept).trim() : '（待补）'),
    risks: () => (risks ? String(risks).trim() : '（待补）'),
    progress: () => (progress ? [progress] : isNew ? [`- ${stampTime()} 建立计划`] : ['- （暂无）']),
  };
  for (const s of SECTIONS) {
    if (s.special) {
      // 决策票据：原文直出（merge 不传时保留旧原文）；空节只留标题 + 一个空行，不写「（待补）」
      if (decisionsText === undefined) continue;
      L.push(`## ${s.name}`, '');
      const body = String(decisionsText).trim();
      if (body) L.push(body, '');
      continue;
    }
    const body = bodies[s.key]();
    if (body === null) continue;
    L.push(`## ${s.name}`, '', ...(Array.isArray(body) ? body : [body]), '');
  }
  // 手写小节原样搬到文末（merge / append），不丢用户自己加的东西
  for (const s of extras ?? []) {
    L.push(`## ${s.name}`, '', s.text ? String(s.text).trim() : '', '');
  }
  return L.join('\n');
}

function normalizeSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps
    .map((s) => {
      const raw = typeof s === 'string' ? s : String(s?.text ?? '');
      const m = /^\s*\[([xX ])\]\s*(.+)$/.exec(raw);
      const explicit = Boolean(m) || (typeof s === 'object' && s !== null && s.done !== undefined);
      const text = (m ? m[2] : raw).trim().replace(/^\d+[.)、]\s*/, '');
      const done = m ? m[1].toLowerCase() === 'x' : Boolean(s?.done);
      return { text, done, explicit };
    })
    .filter((s) => s.text);
}

/** 步骤比对口径：去编号 / 去空白 / 全半角归一 / 去常见标点 —— 只判「相等」，不做包含退让 */
export function normStep(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[，,。.、；;：:（）()【】[\]"'“”‘’—–\-_/\\]/g, '')
    .toLowerCase();
}

function sameText(a, b) {
  const n = (x) => String(x ?? '').normalize('NFKC').replace(/\s+/g, '');
  return n(a) === n(b);
}

/**
 * 把传入步骤并进旧步骤：
 *   相等（normStep）→ 同一步；merge 更新文案、append 不动文案；只有显式给了勾选态才改勾
 *   找不到 → 追加到末尾
 *   旧步骤本次没传 → 一律保留（merge / append）
 */
function mergeSteps(oldSteps, incoming, mode) {
  const stat = { before: oldSteps.length, matched: 0, added: 0, toggled: 0, kept: 0, after: 0 };
  if (mode === 'replace') {
    const out = incoming.map((s) => ({ text: s.text, done: s.done }));
    stat.added = out.length;
    stat.after = out.length;
    return { steps: out, stat };
  }
  const out = oldSteps.map((s) => ({ text: s.text, done: s.done }));
  const taken = new Set();
  for (const inc of incoming) {
    const key = normStep(inc.text);
    let idx = -1;
    for (let i = 0; i < out.length; i += 1) {
      if (taken.has(i)) continue;
      if (normStep(out[i].text) === key) {
        idx = i;
        break;
      }
    }
    if (idx >= 0) {
      taken.add(idx);
      stat.matched += 1;
      if (mode === 'merge') out[idx].text = inc.text;
      if (inc.explicit && out[idx].done !== inc.done) {
        out[idx].done = inc.done;
        stat.toggled += 1;
      }
    } else {
      taken.add(out.length);
      out.push({ text: inc.text, done: inc.done });
      stat.added += 1;
    }
  }
  stat.kept = out.length - stat.added;
  stat.after = out.length;
  return { steps: out, stat };
}

function decisionSummary(rawText) {
  const d = parseDecisions(rawText);
  const counts = decisionCounts(d.tickets);
  return {
    open: counts.open,
    claimed: counts.claimed,
    resolved: counts.resolved,
    outOfScope: counts.outOfScope,
    invalid: counts.invalid,
    issues: d.issues,
  };
}

function decErr(code, tickets, message) {
  const e = new Error(message);
  e.code = code;
  if (tickets) e.tickets = tickets;
  return e;
}

export function savePlan({ workspace, title, goal, gap, scope, decisions, steps, parallel, modes, accept, risks, status, mode, progress }) {
  // 2026-11-04：save 曾经静默丢掉 progress（复盘 A4），改成直接报错指回 update
  if (progress !== undefined && String(progress).trim()) {
    throw new Error('save 不写进度记录：请改用 steward_plan action=update（save 只写节与步骤）');
  }
  if (!workspace) throw new Error('需要 workspace：计划写到哪个工作区根目录');
  if (!exists(workspace)) throw new Error(`工作区不存在：${workspace}`);
  if (!title) throw new Error('需要 title');
  const md = String(mode ?? 'merge').toLowerCase();
  if (!MODES.includes(md)) throw new Error(`mode 只能是 ${MODES.join(' / ')}`);
  const file = path.join(workspace, `PLAN-${slugify(title)}.md`);
  const incomingSteps = normalizeSteps(steps);

  if (!exists(file)) {
    let newDecisionsText = decisions === undefined ? undefined : renderDecisions(parseDecisions(decisions).tickets);
    // append + 空串且无旧节 = 不新增节（SPEC §6.1）
    if (md === 'append' && !newDecisionsText) newDecisionsText = undefined;
    const nextText = render({
      title,
      goal,
      gap,
      scope,
      decisionsText: newDecisionsText,
      steps: incomingSteps,
      parallel,
      modes,
      accept,
      risks,
      status,
      isNew: true,
    });
    // 关闭闸门（SPEC §6.2）：新建文件没有旧节，oldText = null；先审计后写盘
    if (status === 'done') assertDecisionsClosable(nextText);
    writeAtomic(file, nextText);
    return {
      file,
      created: true,
      mode: md,
      steps: { before: 0, matched: 0, added: incomingSteps.length, toggled: 0, kept: 0, after: incomingSteps.length },
      sections: { replaced: newDecisionsText === undefined ? [] : ['decisions'], appended: [], keptExtras: [], droppedExtras: [] },
      decisions: newDecisionsText === undefined ? undefined : decisionSummary(newDecisionsText),
    };
  }

  const raw = fs.readFileSync(file, 'utf8');
  const old = parsePlan(raw);
  const oldMap = {};
  for (const key of SAVE_KEYS) oldMap[key] = old[key];
  const replaced = [];
  const appended = [];

  // 节级：merge 替换 / append 追加 / replace 覆盖（未传的必填节填空）
  const resolve = (key, incoming, required) => {
    const had = oldMap[key] !== undefined;
    if (md === 'replace') {
      if (incoming !== undefined) {
        replaced.push(key);
        return String(incoming).trim();
      }
      return required ? '' : undefined;
    }
    if (incoming === undefined) return had ? oldMap[key] : undefined;
    const next = String(incoming).trim();
    if (md === 'append' && had && oldMap[key]) {
      if (sameText(oldMap[key], next) || String(oldMap[key]).includes(next)) {
        return oldMap[key];
      }
      appended.push(key);
      return `${oldMap[key]}\n\n${next}`;
    }
    replaced.push(key);
    return next;
  };

  const incomingByKey = { goal, gap, scope, parallel, modes, accept, risks };
  const nextByKey = {};
  for (const key of SAVE_KEYS) nextByKey[key] = resolve(key, incomingByKey[key], Boolean(SECTION_BY_KEY[key].required));

  const merged = Array.isArray(steps) ? mergeSteps(old.steps, incomingSteps, md) : null;
  const nextSteps = merged ? merged.steps : old.steps;
  const stepStat = merged ? merged.stat : { before: old.steps.length, matched: 0, added: 0, toggled: 0, kept: old.steps.length, after: old.steps.length };

  const keptExtras = md === 'replace' ? [] : old.extras;
  const droppedExtras = md === 'replace' ? old.extras.map((s) => s.name) : [];

  // 决策票据：六种形态（SPEC §6.1）。传 = 参数出现（含 ''），不传 = undefined
  const oldByKey = sectionsByKey(splitFrontmatter(raw).body);
  const oldDecisionsRaw = 'decisions' in oldByKey ? oldByKey.decisions : undefined;
  const normDecisions = decisions === undefined ? undefined : renderDecisions(parseDecisions(decisions).tickets);
  let nextDecisions;
  if (md === 'replace') {
    nextDecisions = decisions === undefined ? undefined : normDecisions;
    if (decisions !== undefined) replaced.push('decisions');
  } else if (md === 'append') {
    if (decisions === undefined) {
      nextDecisions = oldDecisionsRaw;
    } else {
      const oldIds = new Set(parseDecisions(oldDecisionsRaw ?? '').tickets.map((t) => t.id));
      const clash = [...new Set(parseDecisions(normDecisions).tickets.map((t) => t.id).filter((id) => oldIds.has(id)))];
      if (clash.length) throw decErr('DEC_DUP_ID', clash, `DEC_DUP_ID 追加的票 ID 与旧节冲突：${clash.join(', ')}（文件未写）`);
      if (oldDecisionsRaw === undefined) {
        // 无旧节：等价 merge + 传；'' 不新建节
        nextDecisions = normDecisions ? normDecisions : undefined;
        if (nextDecisions !== undefined) replaced.push('decisions');
      } else if (normDecisions) {
        nextDecisions = `${oldDecisionsRaw.replace(/\s+$/, '')}\n\n${normDecisions}`;
        appended.push('decisions');
      } else {
        nextDecisions = oldDecisionsRaw;
      }
    }
  } else {
    nextDecisions = decisions === undefined ? oldDecisionsRaw : normDecisions;
    if (decisions !== undefined) replaced.push('decisions');
  }

  const nextText = render({
    title,
    ...nextByKey,
    decisionsText: nextDecisions,
    steps: nextSteps,
    status: status ?? old.status,
    created: old.meta.created,
    progress: old.progress,
    isNew: false,
    extras: keptExtras,
  });
  // 关闭闸门（SPEC §6.2）：审计本次 save 按 mode 处理后的最终全文；
  // oldText = 旧「决策票据」节正文（不含标题，无该节 = null），丢票判据只走 assertDecisionsClosable
  if (status === 'done') assertDecisionsClosable(nextText, { oldText: oldDecisionsRaw ?? null });
  writeAtomic(file, nextText);

  return {
    file,
    created: false,
    mode: md,
    steps: stepStat,
    sections: { replaced, appended, keptExtras: keptExtras.map((s) => s.name), droppedExtras },
    decisions: nextDecisions === undefined ? undefined : decisionSummary(nextDecisions),
  };
}

export function updatePlan({ ref, status, progress, stepDone, stepUndone }) {
  const file = resolvePlan(ref);
  const raw = fs.readFileSync(file, 'utf8');
  const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
  const src = raw.slice(bom.length);
  const { meta } = splitFrontmatter(src);
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').split(/\r?\n/);

  // 节名 → 规范键兜底：认别名（`## 进度记录` / `## 步骤`），不写死字符串
  const headingAt = (key) =>
    lines.findIndex((l) => {
      const m = /^##\s+(.+?)\s*$/.exec(l);
      return m ? keyOf(m[1]) === key : false;
    });
  const sectionEnd = (h) => {
    for (let i = h + 1; i < lines.length; i += 1) if (/^##\s+/.test(lines[i])) return i;
    return lines.length;
  };

  const mark = (target, done) => {
    const h = headingAt('steps');
    if (h < 0) return false;
    const end = sectionEnd(h);
    for (let i = h + 1; i < end; i += 1) {
      // 编号可选：老计划里有无编号步骤（`- [ ] 做某事`），按文字也能勾
      const m = /^(\s*-\s*\[)([ xX])(\]\s*(?:(\d+)\.\s*)?)(.+)$/.exec(lines[i]);
      if (!m) continue;
      const same = typeof target === 'number' ? Number(m[4]) === target : m[5].trim().includes(String(target));
      if (!same) continue;
      lines[i] = `${m[1]}${done ? 'x' : ' '}${m[3]}${m[5]}`;
      return true;
    }
    return false;
  };

  if (stepDone) mark(stepDone, true);
  if (stepUndone) mark(stepUndone, false);

  if (progress) {
    const line = `- ${stampTime()} ${String(progress).replace(/\r?\n/g, ' ').trim()}`;
    const h = headingAt('progress');
    if (h < 0) {
      lines.push('', '## 进度记录', '', line);
    } else {
      const end = sectionEnd(h);
      let last = h;
      for (let i = h + 1; i < end; i += 1) if (lines[i].trim()) last = i;
      lines.splice(last + 1, 0, line);
    }
  }

  const now = stampDate();
  const upd = { ...meta, updated: now };
  if (status) upd.status = status;
  const fm = ['---', ...Object.entries(upd).map(([k, v]) => `${k}: ${v}`), '---', ''].join(eol);
  const out = `${fm}${lines.join(eol)}`.replace(/(\r?\n)+$/, eol);
  // 关闭闸门（SPEC §6.2）：审计本次 update 要写出的完整文本（勾选 / 进度已生效），先审计后写盘
  if (status === 'done') assertDecisionsClosable(out);
  writeAtomic(file, bom + out);
  const after = parsePlan(fs.readFileSync(file, 'utf8'));
  return { file, status: after.status, steps: after.steps };
}

/** 去掉 undefined 属性：工具返回值必须能无损走一遍 JSON（undefined 会被丢，校验判为 lossy） */
function dropUndefined(v) {
  if (Array.isArray(v)) return v.map(dropUndefined);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) o[k] = dropUndefined(x);
    return o;
  }
  return v;
}

export function getPlan(ref) {
  const file = resolvePlan(ref);
  const text = fs.readFileSync(file, 'utf8');
  return { file, text, parsed: dropUndefined(parsePlan(text)) };
}

// ---------------------------------------------------------------- 计划质量检查 / 骨架生成（0.2.3）

/** 检查一份计划文本：必填节、档位、派单标记、交付类是否带「文档用法矩阵」、状态与勾选是否矛盾。
 *  节的存在性与正文都从同一个节模型取（不各写一遍正则，避免 audit 绿而 parse 空）。 */
export function auditPlanText(text) {
  const src = String(text ?? '');
  const { body } = splitFrontmatter(src);
  const byKey = sectionsByKey(body);
  const created = (src.match(/^created:\s*(\S+)/m) ?? ['', ''])[1];
  const issues = [];
  const add = (level, msg) => issues.push({ level, msg });

  for (const s of SECTIONS) {
    if (s.required && !(s.key in byKey)) add('fail', `缺必填节：含「${s.short ?? s.name}」的一节`);
  }
  // 只认「步骤」节里的编号步骤（历史上 audit 全文扫，会把别的小节算进来）
  const steps = [];
  for (const line of (byKey.steps ?? '').split(/\r?\n/)) {
    const m = /^- \[([ xX])\]\s*(?:(\d+)\.\s*)?(.+)$/.exec(line);
    if (m) steps.push({ done: m[1].toLowerCase() === 'x', n: m[2] ?? '', text: m[3].trim() });
  }
  if (steps.length < 3) add('warn', `步骤只有 ${steps.length} 条（建议 ≥3）`);
  const legacy = created < '2026-11-02';
  const noLevel = steps.filter((s) => !/\[(Off|Low|High|Max)\]/.test(s.text));
  if (noLevel.length && !legacy) add('warn', `${noLevel.length} 条步骤没标档位（[High]/[Max]…）`);
  const noRoute = steps.filter((s) => !/\[(自做|MiMo-flash|MiMo-pro)\]/.test(s.text));
  if (noRoute.length && !legacy) add('warn', `${noRoute.length} 条步骤没标派单（[自做]/[MiMo-…]）`);

  const scopeBlock = byKey.scope ?? '';
  const isDelivery = /交付|成品|打包|脚本|插件|工具包/.test(scopeBlock);
  // 历史计划（11-03 前建立）从宽：不追溯要求用法矩阵，也不报提醒
  if (isDelivery && !src.includes('文档用法矩阵') && created >= '2026-11-03') {
    add('fail', '交付类项目缺「文档用法矩阵」节（2026-11-03 后新计划必须写）');
  }

  const status = (src.match(/^status:\s*(\S+)/m) ?? ['', 'active'])[1];
  // 并行 / 工作树（按需节）：只对进行中的计划提示，避免给已收尾计划翻旧账（只 warn，不影响 ok）
  const hasParallel = 'parallel' in byKey;
  if (status === 'active') {
    if (hasParallel) {
      const block = String(byKey.parallel ?? '').trim();
      if (!block || block === '（待补）') {
        add('warn', '并行 / 工作树节没内容（写清哪些步骤互不依赖、开哪棵树、怎么合并回主树）');
      } else if (!/工作树|worktree|主树|树名/i.test(block)) {
        add('warn', '并行 / 工作树节没写树归属（主树 / 树名 / 基线）');
      }
    } else {
      const parallelSteps = steps.filter((s) => /\[并行\]\s*$/.test(s.text));
      if (parallelSteps.length) add('warn', `${parallelSteps.length} 条步骤标了 [并行] 但缺「并行 / 工作树」节（写清开哪棵、怎么合并回主树）`);
    }
  }
  const done = steps.filter((s) => s.done).length;
  if (steps.length && done === steps.length && status === 'active') add('warn', '步骤已全勾但 status 仍是 active（该 update 收尾）');
  if (done < steps.length && status === 'done') add('warn', `status=done 但只完成 ${done}/${steps.length} 步`);

  // 决策票据：节存在才审计；DEC_PENDING 是 check 视图的合成 warn（不进 parseDecisions）
  let decisionsInfo;
  if ('decisions' in byKey) {
    const d = parseDecisions(byKey.decisions);
    for (const i of d.issues) issues.push(i);
    const counts = decisionCounts(d.tickets);
    const pendingIds = firstTickets(d.tickets)
      .filter((t) => PENDING_STATUSES.includes(t.status))
      .map((t) => t.id);
    if (pendingIds.length) {
      issues.push({
        level: 'warn',
        code: 'DEC_PENDING',
        ticket: null,
        msg: `仍有 ${pendingIds.length} 张未决票：${pendingIds.join(', ')}${d.frontier.length ? `；前沿：${d.frontier.join(', ')}` : '；前沿：无'}`,
      });
    }
    decisionsInfo = { ...counts, frontier: d.frontier, issues: d.issues };
  }

  const fails = issues.filter((i) => i.level === 'fail').length;
  // 无「决策票据」节时 decisionsInfo 为 undefined：整个键不出现，而不是挂一个 undefined。
  // 工具面把这份 rows 原样返回给宿主，带 undefined 属性会被「无损 JSON」校验判失败——
  // 2026-11-07 修：steward_plan check 对 36/36 无票据节的计划一律报 not lossless JSON。
  const result = { ok: fails === 0, issues, steps: steps.length, done, status };
  if (decisionsInfo !== undefined) result.decisions = decisionsInfo;
  return result;
}

/**
 * 关闭闸门（SPEC §6.2）：判据只有一个，三个关闭入口共用。
 * @param {string} finalText 即将落盘的完整计划文本
 * @param {{oldText?: string|null}} [opts] oldText = 旧文件「决策票据」节正文（不含标题；无该节 = null）
 * 抛出的 Error 固定字段：code / message（含 code 与票 ID）/ issues（全部 fail）/ tickets（仅 DEC_PENDING）
 */
export function assertDecisionsClosable(finalText, { oldText = null } = {}) {
  const src = String(finalText ?? '');
  const byKey = sectionsByKey(splitFrontmatter(src).body);
  const final = parseDecisions('decisions' in byKey ? byKey.decisions : '');
  const fails = final.issues.filter((i) => i.level === 'fail');
  const gone = [];

  if (oldText !== null) {
    const old = parseDecisions(oldText);
    const finalIds = new Set(final.tickets.map((t) => t.id));
    const seen = new Set();
    for (const t of old.tickets) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      if (PENDING_STATUSES.includes(t.status) && !finalIds.has(t.id)) gone.push(t.id);
    }
    // 旧节里 fail 所属票块在最终全文消失（整节删 / 清空 / 单块删）→ 旧 fail 原样计入
    const oldFailByTicket = new Map();
    for (const i of old.issues) {
      if (i.level !== 'fail' || !i.ticket) continue;
      if (!oldFailByTicket.has(i.ticket)) oldFailByTicket.set(i.ticket, []);
      oldFailByTicket.get(i.ticket).push(i);
    }
    for (const [id, list] of oldFailByTicket) if (!finalIds.has(id)) fails.push(...list);
  }

  if (fails.length) {
    const rank = (c) => {
      const i = DECISION_CODE_ORDER.indexOf(c);
      return i < 0 ? 99 : i;
    };
    const sorted = [...fails].sort((a, b) => rank(a.code) - rank(b.code));
    const code = sorted[0].code;
    const ids = [...new Set(fails.map((i) => i.ticket).filter(Boolean))];
    const err = decErr(code, undefined, `${code} 票据校验未通过${ids.length ? `：${ids.join(', ')}` : ''}`);
    err.issues = fails;
    throw err;
  }

  const finalPending = [...new Set(final.tickets.filter((t) => PENDING_STATUSES.includes(t.status)).map((t) => t.id))];
  const all = [...new Set([...gone, ...finalPending])];
  if (all.length) {
    const err = decErr('DEC_PENDING', all, `DEC_PENDING 仍有未决票：${all.join(', ')}`);
    err.issues = [];
    throw err;
  }
}

// ---------------------------------------------------------------- 受控写（SPEC §12，v1.3）

const failKeyOf = (i) => `${i.code}|${i.ticket ?? ''}|${i.field ?? ''}|${i.msg ?? ''}`;
const codeRank = (c) => {
  const i = DECISION_CODE_ORDER.indexOf(c);
  return i < 0 ? 99 : i;
};

/** 只戳 frontmatter 的 updated 行，其余字节不动（无 frontmatter 时原样返回）。
 *  行尾按 frontmatter 自己的换行风格，别被正文的 CRLF 带偏（混合 EOL 文件）。 */
function stampUpdated(src, day) {
  const eol = (src.match(/^---(\r?\n)/) ?? [null, '\n'])[1];
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src);
  if (!m) return src;
  const inner = m[1];
  const nextInner = /^updated:[^\r\n]*/m.test(inner)
    ? inner.replace(/^updated:[^\r\n]*/m, `updated: ${day}`)
    : `${inner}${eol}updated: ${day}`;
  return `---${eol}${nextInner}${eol}---${src.slice(m[0].length)}`;
}

/**
 * 受控写的唯一写路径：读 → parseDecisions → mutate(tickets) → renderDecisions → **只替换决策票据节**。
 *
 * 节外字节一律不动（BOM / CRLF / 节级说明 / 步骤节里的说明段和代码围栏都保留），只戳 updated。
 * 只拒「本次新增的 fail」：老计划里已有的票据 fail 不挡住别的票（否则一张脏票锁死全节）；
 * 但节里已有重复 ID 时整节拒写（改哪块都不确定），见 SPEC §12。
 * 非原子：读改写之间没有 CAS / 锁；两次调用并发以最后落盘为准（后写覆盖先写），不承诺独占。
 * @param {{ref: string, mutate?: (tickets: object[]) => object[]}} opts
 */
export function mutateDecisions({ ref, mutate }) {
  const file = resolvePlan(ref);
  if (!PLAN_RE.test(path.basename(file))) {
    throw decErr('DEC_NOT_PLAN', undefined, `DEC_NOT_PLAN 只能改 PLAN-*.md：${path.basename(file)}（文件未写）`);
  }
  const raw = fs.readFileSync(file, 'utf8');
  const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
  const src = raw.slice(bom.length);
  const old = parsePlan(src);
  if (old.status === 'done') {
    throw decErr('DEC_READONLY', undefined, 'DEC_READONLY 计划已收尾（status=done）：不再改动决策票据；要改先 update status=active');
  }
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const stamped = stampUpdated(src, stampDate());
  const { body } = splitFrontmatter(stamped);
  const secs = parseSections(body);
  const hit = secs.find((s) => s.key === 'decisions') ?? null;
  const before = parseDecisions(hit ? hit.text : '');
  const dups = duplicateTicketIds(before.tickets);
  if (dups.length) {
    throw decErr('DEC_DUP_ID', dups, `DEC_DUP_ID 票据 ID 重复：${dups.join(', ')}（先修好重复 ID 再动票，文件未写）`);
  }
  const beforeFails = new Set(before.issues.filter((i) => i.level === 'fail').map(failKeyOf));
  const tickets = mutate ? mutate(before.tickets) : before.tickets;
  const nextSectionText = renderDecisions(tickets);
  // init 幂等：节已在且票没变 → 不写盘（连字节都不碰）
  if (hit && JSON.stringify(tickets) === JSON.stringify(before.tickets)) {
    return { file, hadSection: true, changed: false, decisions: decisionSummary(nextSectionText), issues: before.issues };
  }
  const after = parseDecisions(nextSectionText);
  const introduced = after.issues.filter((i) => i.level === 'fail' && !beforeFails.has(failKeyOf(i)));
  if (introduced.length) {
    const first = [...introduced].sort((a, b) => codeRank(a.code) - codeRank(b.code))[0];
    const err = decErr(first.code, undefined, `${first.code} 受控写被拒：${introduced.map((i) => i.msg).join('；')}（文件未写）`);
    err.issues = introduced;
    throw err;
  }
  // 只重建「决策票据」这一段：正文按规范形态；中间节与下一节之间留一个空行；
  // 本节是最后一节时按规范收尾（不改文件前面的任何字节，也不动节外 EOF 空白）。
  const decText = nextSectionText ? nextSectionText.split('\n').join(eol) : '';
  const region = decText ? `${eol}${decText}${eol}` : '';
  let nextBody;
  if (hit) {
    const after = body.slice(hit.end);
    nextBody = body.slice(0, hit.bodyStart) + region + (after ? eol : '') + after;
  } else {
    const stepsSec = secs.find((s) => s.key === 'steps');
    if (stepsSec) {
      const block = `## 决策票据${eol}${decText ? `${eol}${decText}${eol}${eol}` : eol}`;
      nextBody = body.slice(0, stepsSec.lineStart) + block + body.slice(stepsSec.lineStart);
    } else {
      const sep = /\n$/.test(body) ? eol : `${eol}${eol}`;
      nextBody = `${body}${sep}## 决策票据${eol}${decText ? `${eol}${decText}${eol}` : eol}`;
    }
  }
  const prefix = stamped.slice(0, stamped.length - body.length);
  writeAtomic(file, bom + prefix + nextBody);
  return { file, hadSection: hit !== null, changed: true, decisions: decisionSummary(nextSectionText), issues: after.issues };
}

/** init：确保计划里有 `## 决策票据` 节（有就不新建）；幂等 */
export function initDecisions(ref) {
  const r = mutateDecisions({ ref, mutate: (tickets) => tickets });
  return { ...r, created: !r.hadSection };
}

/** ticket：追加一张 open 票；id 省略时自动取下一个号码 */
export function addDecisionTicket(ref, spec = {}) {
  let added = null;
  const r = mutateDecisions({
    ref,
    mutate: (tickets) => {
      const next = addTicket(tickets, spec);
      added = next[next.length - 1];
      return next;
    },
  });
  return { ...r, ticket: added };
}

/** claim：open → claimed（记 claimed_by/at；只记录，不承诺独占） */
export function claimDecision(ref, id, by) {
  const at = stampTime();
  const want = String(id ?? '').trim().toUpperCase();
  let claimed = null;
  const r = mutateDecisions({
    ref,
    mutate: (tickets) => {
      const next = claimTicket(tickets, id, by, at);
      claimed = next.find((t) => t.id === want) ?? null;
      return next;
    },
  });
  return { ...r, ticket: claimed, at };
}

/** resolve：open/claimed → resolved / out-of-scope（写 resolution + resolved_at） */
export function resolveDecision(ref, id, { resolution, status } = {}) {
  const at = stampTime();
  const want = String(id ?? '').trim().toUpperCase();
  let solved = null;
  const r = mutateDecisions({
    ref,
    mutate: (tickets) => {
      const next = resolveTicket(tickets, id, { resolution, status, at });
      solved = next.find((t) => t.id === want) ?? null;
      return next;
    },
  });
  return { ...r, ticket: solved, at };
}

export function auditPlan(ref) {
  const r = getPlan(ref);
  return { file: r.file, ...auditPlanText(r.text) };
}

export function auditAllPlans() {
  return listPlans().map((p) => {
    try {
      const r = auditPlan(p.file);
      return { ...r, title: p.title, workspace: p.workspace };
    } catch (e) {
      return { file: p.file, title: p.title, ok: false, issues: [{ level: 'fail', msg: '读不到：' + e.message }], steps: 0, done: 0, status: p.status };
    }
  });
}

/** 生成计划骨架：六个必填节 + 交付类默认带「文档用法矩阵」+ 步骤占位（含档位/派单标记）。
 *  正文由 render 统一产出（节名/顺序跟着 SECTIONS 走），保证 scaffold → parse 往返没有手写节。 */
export function scaffoldPlan({ workspace, title, goal = '', scope = '', steps = [] }) {
  if (!workspace) throw new Error('需要 workspace');
  if (!title) throw new Error('需要 title');
  if (!exists(workspace)) throw new Error(`工作区不存在：${workspace}`);
  const file = path.join(workspace, `PLAN-${slugify(title)}.md`);
  if (exists(file)) return { file, created: false, exists: true };
  const day = stampDate();
  const stepList = (steps.length ? steps : ['（待补：第一件可验证的事）', '（待补：做完能交付的东西）', '（待补：验收与收尾）']).map((s) => ({
    text: `${String(s).trim()} — [High] [自做]`,
    done: false,
  }));
  const text = render({
    title,
    goal: goal || '（待补：做完算什么成功，一句可验收的话）',
    scope: scope || '做：（待补）\n\n不做：（待补）',
    steps: stepList,
    accept: [
      '（待补：逐条可执行的判据；交付类补「文档用法矩阵」）',
      '',
      '### 文档用法矩阵',
      '',
      '| 用法 | 期望 | 实跑证据（退出码 / 产物路径） |',
      '|---|---|---|',
      '| （待补） | （待补） | （待补） |',
    ].join('\n'),
    risks: '（待补：最坏会怎样、怎么退、备份在哪）',
    status: 'active',
    created: day,
    isNew: false,
    progress: [`- ${day} 建立计划（steward_plan scaffold）`],
    extras: [],
  });
  writeAtomic(file, text);
  return { file, created: true, exists: false };
}

// 决策票据纯函数（SPEC §11：dev 夹具直接从 lib/plan.js import）
export { parseDecisions, renderDecisions };
