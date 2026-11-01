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
 */
import fs from 'node:fs';
import path from 'node:path';
import { exists, workspaces } from './core.js';

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

function splitFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]] = kv[2];
  }
  return { meta, body: text.slice(m[0].length) };
}

/** 二级标题名 → 规范键；认不出返回 null（= 手写小节） */
const NAME_TO_KEY = {
  目标: 'goal',
  差距对照: 'gap',
  范围: 'scope',
  步骤: 'steps',
  执行档位: 'modes',
  验收: 'accept',
  '风险 / 回滚': 'risks',
  '风险/回滚': 'risks',
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

/** 按二级标题切节，保留顺序与原文（手写小节也在里面） */
export function parseSections(body) {
  const out = [];
  const re = /^##\s+(.+?)\s*$/gm;
  let hit;
  while ((hit = re.exec(body))) {
    const start = hit.index + hit[0].length;
    const rest = body.slice(start);
    const next = /^##\s+/m.exec(rest);
    const text = (next ? rest.slice(0, next.index) : rest).replace(/^\r?\n/, '').replace(/\s+$/, '');
    out.push({ name: hit[1].trim(), key: keyOf(hit[1]), text });
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
  const byKey = {};
  for (const s of secs) if (s.key && !(s.key in byKey)) byKey[s.key] = s.text;
  const steps = [];
  if (byKey.steps !== undefined) {
    for (const line of byKey.steps.split(/\r?\n/)) {
      const m = /^\s*-\s*\[([ xX])\]\s*(.+)$/.exec(line);
      if (m) steps.push({ done: m[1].toLowerCase() === 'x', text: m[2].trim().replace(/^\d+\.\s*/, '') });
    }
  }
  const pick = (key) => byKey[key] ?? '';
  // 按需节：不存在时返回 undefined，好让 save 区分「没写」和「写空了」
  const opt = (key) => (key in byKey ? byKey[key] : undefined);
  return {
    meta,
    title: titleLine?.[1]?.trim() || meta.title || '',
    status: meta.status || 'active',
    goal: pick('goal'),
    gap: opt('gap'),
    scope: pick('scope'),
    accept: pick('accept'),
    modes: opt('modes'),
    risks: pick('risks'),
    steps,
    progress: pick('progress'),
    extras: secs.filter((s) => !s.key).map((s) => ({ name: s.name, text: s.text })),
  };
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
  throw new Error(`没找到计划：${r}。可用 koujing_plan list 看现有计划`);
}

function render({ title, goal, gap, scope, steps, modes, accept, risks, status, created, progress, isNew, extras }) {
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
    '## 目标',
    '',
    goal ? String(goal).trim() : '（待补）',
    '',
  ];
  // 按需节：只有调用方给了值（含空串）才出现在文件里，避免小项目被格式拖累
  if (gap !== undefined) L.push('## 差距对照', '', gap ? String(gap).trim() : '（待补）', '');
  L.push(
    '## 范围',
    '',
    scope ? String(scope).trim() : '- 做：\n- 不做：',
    '',
    '## 步骤',
    '',
    ...(steps && steps.length
      ? steps.map((s, i) => `- [${s.done ? 'x' : ' '}] ${i + 1}. ${s.text}`)
      : ['- [ ] 1. （待补）']),
    '',
  );
  if (modes !== undefined) L.push('## 执行档位', '', modes ? String(modes).trim() : '（待补）', '');
  L.push(
    '## 验收',
    '',
    accept ? String(accept).trim() : '（待补）',
    '',
    '## 风险 / 回滚',
    '',
    risks ? String(risks).trim() : '（待补）',
    '',
    '## 进度记录',
    '',
    ...(progress ? [progress] : isNew ? [`- ${stampTime()} 建立计划`] : ['- （暂无）']),
    '',
  );
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

export function savePlan({ workspace, title, goal, gap, scope, steps, modes, accept, risks, status, mode }) {
  if (!workspace) throw new Error('需要 workspace：计划写到哪个工作区根目录');
  if (!exists(workspace)) throw new Error(`工作区不存在：${workspace}`);
  if (!title) throw new Error('需要 title');
  const md = String(mode ?? 'merge').toLowerCase();
  if (!MODES.includes(md)) throw new Error(`mode 只能是 ${MODES.join(' / ')}`);
  const file = path.join(workspace, `PLAN-${slugify(title)}.md`);
  const incomingSteps = normalizeSteps(steps);

  if (!exists(file)) {
    fs.writeFileSync(
      file,
      render({
        title,
        goal,
        gap,
        scope,
        steps: md === 'replace' ? incomingSteps : incomingSteps,
        modes,
        accept,
        risks,
        status,
        isNew: true,
      }),
      'utf8',
    );
    return {
      file,
      created: true,
      mode: md,
      steps: { before: 0, matched: 0, added: incomingSteps.length, toggled: 0, kept: 0, after: incomingSteps.length },
      sections: { replaced: [], appended: [], keptExtras: [], droppedExtras: [] },
    };
  }

  const raw = fs.readFileSync(file, 'utf8');
  const old = parsePlan(raw);
  const oldMap = {
    goal: old.goal,
    gap: old.gap,
    scope: old.scope,
    modes: old.modes,
    accept: old.accept,
    risks: old.risks,
  };
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

  const nextGoal = resolve('goal', goal, true);
  const nextGap = resolve('gap', gap, false);
  const nextScope = resolve('scope', scope, true);
  const nextModes = resolve('modes', modes, false);
  const nextAccept = resolve('accept', accept, true);
  const nextRisks = resolve('risks', risks, true);

  const merged = Array.isArray(steps) ? mergeSteps(old.steps, incomingSteps, md) : null;
  const nextSteps = merged ? merged.steps : old.steps;
  const stepStat = merged ? merged.stat : { before: old.steps.length, matched: 0, added: 0, toggled: 0, kept: old.steps.length, after: old.steps.length };

  const keptExtras = md === 'replace' ? [] : old.extras;
  const droppedExtras = md === 'replace' ? old.extras.map((s) => s.name) : [];

  fs.writeFileSync(
    file,
    render({
      title,
      goal: nextGoal,
      gap: nextGap,
      scope: nextScope,
      steps: nextSteps,
      modes: nextModes,
      accept: nextAccept,
      risks: nextRisks,
      status: status ?? old.status,
      created: old.meta.created,
      progress: old.progress,
      isNew: false,
      extras: keptExtras,
    }),
    'utf8',
  );

  return {
    file,
    created: false,
    mode: md,
    steps: stepStat,
    sections: { replaced, appended, keptExtras: keptExtras.map((s) => s.name), droppedExtras },
  };
}

export function updatePlan({ ref, status, progress, stepDone, stepUndone }) {
  const file = resolvePlan(ref);
  const raw = fs.readFileSync(file, 'utf8');
  const { meta } = splitFrontmatter(raw);
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').split(/\r?\n/);

  const headingAt = (name) => lines.findIndex((l) => new RegExp(`^##\\s+${name}\\s*$`).test(l));
  const sectionEnd = (h) => {
    for (let i = h + 1; i < lines.length; i += 1) if (/^##\s+/.test(lines[i])) return i;
    return lines.length;
  };

  const mark = (target, done) => {
    const h = headingAt('步骤');
    if (h < 0) return false;
    const end = sectionEnd(h);
    for (let i = h + 1; i < end; i += 1) {
      const m = /^(\s*-\s*\[)([ xX])(\]\s*(\d+)\.\s*)(.+)$/.exec(lines[i]);
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
    const h = headingAt('进度记录');
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
  fs.writeFileSync(file, out, 'utf8');
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
