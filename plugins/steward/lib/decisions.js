/**
 * 决策票据 v1.2：解析 / 归一化 / 渲染（契约见 SPEC-决策票据-v1.md §3–§5、§7）。
 *
 * 只处理 `## 决策票据` 的节正文（不含节标题）；frontier 与 issues 都从这里派生，不落盘。
 * 纯函数，不读文件：save(decisions) 的写路径 parse → normalize → render 也走这里。
 */

export const DECISION_TYPES = ['research', 'prototype', 'grilling', 'task'];
export const DECISION_STATUSES = ['open', 'claimed', 'resolved', 'out-of-scope'];
export const PENDING_STATUSES = ['open', 'claimed'];
export const TERMINAL_STATUSES = ['resolved', 'out-of-scope'];
export const DECISION_ID_RE = /^T-\d{2,}$/;

const HEAD_RE = /^###\s+(T-\d{2,})\s*(.*)$/;
const FIELD_RE = /^-\s+([^:]+?)\s*:\s*(.*)$/;
const FIELD_ORDER = ['type', 'status', 'blocked_by', 'question', 'claimed_by', 'claimed_at', 'resolution', 'resolved_at', 'links'];
const KNOWN_FIELDS = new Set(FIELD_ORDER);
/** 固定码序：err.code 取首个 fail、票内 issues 排序都用这一套（SPEC §7.1） */
export const DECISION_CODE_ORDER = [
  'DEC_DUP_ID',
  'DEC_FIELD_MISSING',
  'DEC_STATUS',
  'DEC_DUP_FIELD',
  'DEC_UNKNOWN_FIELD',
  'DEC_RESOLUTION_MISSING',
  'DEC_REOPENED',
  'DEC_CLAIM_NO_OWNER',
  'DEC_TIME_MISSING',
  'DEC_STATUS_CONFLICT',
  'DEC_REF_MISSING',
  'DEC_SELF_BLOCK',
  'DEC_BLOCKER_SCOPED_OUT',
  'DEC_CYCLE',
  'DEC_PENDING',
];
const CODE_RANK = Object.fromEntries(DECISION_CODE_ORDER.map((c, i) => [c, i]));

const issue = (level, code, ticket, msg, field) => {
  const out = { level, code, msg, ticket };
  if (field !== undefined) out.field = field;
  return out;
};

const isBlank = (v) => v === null || v === undefined || String(v).trim() === '';
const splitList = (v) =>
  String(v ?? '')
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(/[,，、;；\s]+/)
    .map((s) => s.trim())
    .filter((s) => s && s !== '-' && s !== '无');

function emptyTicket(id, title) {
  return {
    id,
    title: isBlank(title) ? null : String(title).trim(),
    type: null,
    status: null,
    blocked_by: [],
    question: null,
    claimed_by: null,
    claimed_at: null,
    resolution: null,
    resolved_at: null,
    links: [],
    unknown: [],
    body: '',
  };
}

const blankEdges = (lines) => {
  const out = [...lines];
  while (out.length && !String(out[0]).trim()) out.shift();
  while (out.length && !String(out[out.length - 1]).trim()) out.pop();
  return out;
};

/** 解析一节票块文本 → {tickets, frontier, issues}（SPEC §3.1） */
export function parseDecisions(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const blocks = [];
  for (const line of src.split(/\r?\n/)) {
    const m = HEAD_RE.exec(line);
    if (m) {
      blocks.push({ id: m[1], title: m[2].trim(), lines: [] });
    } else if (blocks.length) {
      blocks[blocks.length - 1].lines.push(line);
    }
  }

  const tickets = [];
  const firstById = new Map();
  /** @type {{ticket:object, local:any[], dup:boolean}[]} 按文件顺序 */
  const perTicket = [];

  for (const b of blocks) {
    const t = emptyTicket(b.id, b.title);
    const dup = firstById.has(t.id);
    const local = [];
    const effective = new Map();
    const dupField = new Set();
    const unknownSeen = new Map();
    const bodyLines = [];

    for (const line of b.lines) {
      const fm = FIELD_RE.exec(line);
      if (!fm) {
        bodyLines.push(line);
        continue;
      }
      const key = fm[1].trim().toLowerCase();
      const value = fm[2].trim();
      if (KNOWN_FIELDS.has(key)) {
        if (effective.has(key) && !dupField.has(key)) {
          dupField.add(key);
          if (!dup) local.push(issue('warn', 'DEC_DUP_FIELD', t.id, `字段重复：${key}（后者生效）`, key));
        }
        effective.set(key, value);
      } else {
        if (!unknownSeen.has(key)) {
          unknownSeen.set(key, value);
          if (!dup) local.push(issue('warn', 'DEC_UNKNOWN_FIELD', t.id, `未知字段：${key}（保留原文，首次出现序回填）`, key));
        } else {
          unknownSeen.set(key, value);
        }
      }
    }
    t.body = blankEdges(bodyLines).join('\n');

    const get = (k) => effective.get(k) ?? '';
    if (!isBlank(get('title'))) t.title = String(get('title')).trim();
    // type / status：trim + 小写；非法值也原样存（SPEC §3.1）
    if (!isBlank(get('type'))) t.type = String(get('type')).trim().toLowerCase();
    if (!isBlank(get('status'))) t.status = String(get('status')).trim().toLowerCase();
    t.blocked_by = [...new Set(splitList(get('blocked_by')).map((s) => s.toUpperCase()))];
    if (!isBlank(get('question'))) t.question = String(get('question')).trim();
    if (!isBlank(get('claimed_by'))) t.claimed_by = String(get('claimed_by')).trim();
    if (!isBlank(get('claimed_at'))) t.claimed_at = String(get('claimed_at')).trim();
    if (!isBlank(get('resolution'))) t.resolution = String(get('resolution')).trim();
    if (!isBlank(get('resolved_at'))) t.resolved_at = String(get('resolved_at')).trim();
    t.links = [...new Set(splitList(get('links')).map((s) => s.trim()))];
    t.unknown = [...unknownSeen.entries()].map(([key, value]) => ({ key, value }));

    if (dup) {
      // 第二个块只出 DEC_DUP_ID，不校验字段、不报字段级问题（SPEC §4 C4）
      local.push(issue('fail', 'DEC_DUP_ID', t.id, `票 ID 重复：${t.id}（只校验首个块）`));
    } else {
      firstById.set(t.id, t);
      if (t.title === null) local.push(issue('fail', 'DEC_FIELD_MISSING', t.id, '票标题缺失（### T-xx 后为空）', 'title'));
      if (t.type === null) local.push(issue('fail', 'DEC_FIELD_MISSING', t.id, '必填字段缺失：type', 'type'));
      else if (!DECISION_TYPES.includes(t.type)) local.push(issue('fail', 'DEC_STATUS', t.id, `非法 type：${t.type}`, 'type'));
      if (t.status === null) local.push(issue('fail', 'DEC_FIELD_MISSING', t.id, '必填字段缺失：status', 'status'));
      else if (!DECISION_STATUSES.includes(t.status)) local.push(issue('fail', 'DEC_STATUS', t.id, `非法 status：${t.status}`, 'status'));
      if (t.question === null) local.push(issue('fail', 'DEC_FIELD_MISSING', t.id, '必填字段缺失：question', 'question'));
      if (TERMINAL_STATUSES.includes(t.status) && t.resolution === null) {
        local.push(issue('fail', 'DEC_RESOLUTION_MISSING', t.id, '终态缺 resolution', 'resolution'));
      }
      if (PENDING_STATUSES.includes(t.status) && (t.resolution !== null || t.resolved_at !== null)) {
        local.push(issue('fail', 'DEC_REOPENED', t.id, '终态残留：status 回到未决但 resolution/resolved_at 还在'));
      }
      if (t.status === 'claimed' && t.claimed_by === null) {
        local.push(issue('fail', 'DEC_CLAIM_NO_OWNER', t.id, 'status=claimed 但缺 claimed_by', 'claimed_by'));
      }
      if (TERMINAL_STATUSES.includes(t.status) && t.resolved_at === null) {
        local.push(issue('warn', 'DEC_TIME_MISSING', t.id, '终态缺 resolved_at', 'resolved_at'));
      }
      if (t.status === 'claimed' && t.claimed_at === null) {
        local.push(issue('warn', 'DEC_TIME_MISSING', t.id, 'claimed 缺 claimed_at', 'claimed_at'));
      }
      if (t.claimed_by !== null && t.status === 'open') {
        local.push(issue('warn', 'DEC_STATUS_CONFLICT', t.id, 'claimed_by 有值但 status=open（按已认领处理）'));
      }
    }
    perTicket.push({ ticket: t, local, dup });
    tickets.push(t);
  }

  // —— 引用 / 自环 / 出圈阻塞（需要全量票表，只对首个块）——
  const firsts = tickets.filter((t) => firstById.get(t.id) === t);
  const byId = new Map(firsts.map((t) => [t.id, t]));
  for (const entry of perTicket) {
    if (entry.dup) continue;
    const t = entry.ticket;
    if (t.blocked_by.includes(t.id)) {
      entry.local.push(issue('fail', 'DEC_SELF_BLOCK', t.id, `票阻塞自己：${t.id}`));
    }
    for (const id of t.blocked_by) {
      if (id === t.id) continue;
      if (!byId.has(id)) entry.local.push(issue('fail', 'DEC_REF_MISSING', t.id, `blocked_by 指向不存在的票：${id}`, 'blocked_by'));
    }
    if (PENDING_STATUSES.includes(t.status)) {
      for (const id of t.blocked_by) {
        const blocker = byId.get(id);
        if (blocker && blocker.status === 'out-of-scope') {
          entry.local.push(issue('warn', 'DEC_BLOCKER_SCOPED_OUT', t.id, `阻塞者 ${id} 已 out-of-scope（不会解锁）`));
        }
      }
    }
  }

  const cycles = findCycles(firsts, byId);
  const graphIssues = cycles.map((ids) => issue('fail', 'DEC_CYCLE', null, `阻塞成环：${ids.join(' → ')}`));

  // 票内问题：文件顺序 + 固定码序；图级追加在票内之后（SPEC §7.1）
  const issues = [];
  for (const entry of perTicket) {
    entry.local.sort((a, b) => (CODE_RANK[a.code] ?? 99) - (CODE_RANK[b.code] ?? 99));
    issues.push(...entry.local);
  }
  issues.push(...graphIssues);

  const hasFail = issues.some((i) => i.level === 'fail');
  const frontier = hasFail ? [] : computeFrontier(firsts);
  return { tickets, frontier, issues };
}

function computeFrontier(firsts) {
  const byId = new Map(firsts.map((t) => [t.id, t]));
  return firsts
    .filter((t) => t.status === 'open' && t.claimed_by === null)
    .filter((t) => t.blocked_by.every((id) => byId.get(id)?.status === 'resolved'))
    .map((t) => t.id);
}

function findCycles(firsts, byId) {
  const nodes = firsts.map((t) => t.id).filter((id) => byId.has(id));
  const adj = new Map(nodes.map((id) => [id, []]));
  for (const t of firsts) {
    for (const id of t.blocked_by) {
      if (id !== t.id && byId.has(id) && adj.has(t.id)) adj.get(t.id).push(id);
    }
  }
  // Tarjan SCC
  let index = 0;
  const idx = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const out = [];
  const strong = (v) => {
    idx.set(v, index);
    low.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!idx.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), idx.get(w)));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const comp = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1) out.push(comp.sort());
    }
  };
  for (const id of nodes) if (!idx.has(id)) strong(id);
  return out;
}

/** 规范渲染：只出票块（不含节标题），字段顺序固定（SPEC §3.2） */
export function renderDecisions(tickets) {
  const blocks = (Array.isArray(tickets) ? tickets : []).map((t) => {
    const lines = [`### ${t.id}${t.title ? ` ${String(t.title).trim()}` : ''}`];
    const push = (key, value) => {
      if (value !== null && value !== undefined && String(value).trim() !== '') lines.push(`- ${key}: ${String(value).trim()}`);
    };
    push('type', t.type);
    push('status', t.status);
    if (t.blocked_by && t.blocked_by.length) lines.push(`- blocked_by: [${t.blocked_by.join(', ')}]`);
    push('question', t.question);
    push('claimed_by', t.claimed_by);
    push('claimed_at', t.claimed_at);
    push('resolution', t.resolution);
    push('resolved_at', t.resolved_at);
    if (t.links && t.links.length) lines.push(`- links: ${t.links.join(', ')}`);
    for (const u of t.unknown ?? []) lines.push(`- ${u.key}: ${u.value}`);
    if (t.body) lines.push('', t.body);
    return lines.join('\n');
  });
  return blocks.join('\n\n');
}

/** 计数（只看首个块；invalid = status 缺失/空或非枚举） */
export function decisionCounts(tickets) {
  const list = Array.isArray(tickets) ? tickets : [];
  const firsts = [];
  const seen = new Set();
  for (const t of list) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    firsts.push(t);
  }
  const out = { open: 0, claimed: 0, resolved: 0, outOfScope: 0, invalid: 0 };
  for (const t of firsts) {
    if (t.status === 'open') out.open += 1;
    else if (t.status === 'claimed') out.claimed += 1;
    else if (t.status === 'resolved') out.resolved += 1;
    else if (t.status === 'out-of-scope') out.outOfScope += 1;
    else out.invalid += 1;
  }
  out.pending = out.open + out.claimed;
  return out;
}

/** 首个块（计数 / 前沿 / 引用只看首个块） */
export function firstTickets(tickets) {
  const seen = new Set();
  const out = [];
  for (const t of Array.isArray(tickets) ? tickets : []) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------- 受控写（SPEC §13，v1.3）
/**
 * 动作级错误码：只经 err.code 抛出，不进 issues 数组（issues 只放解析期问题，§3.1）。
 * 非原子：这里是纯函数，读写盘由 plan.js 的 mutateDecisions 负责；单文件 markdown 没有 CAS。
 */
export const DECISION_ACTION_CODES = ['DEC_NOT_FOUND', 'DEC_STATE', 'DEC_READONLY', 'DEC_INVALID_ID'];

function actionErr(code, msg, extra) {
  const e = new Error(msg);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

const oneLine = (v) => String(v ?? '').replace(/\r?\n/g, ' ').trim();

/** 重复 ID（受控写前必须为 0，否则改哪块都不确定） */
export function duplicateTicketIds(tickets) {
  const seen = new Set();
  const dup = new Set();
  for (const t of Array.isArray(tickets) ? tickets : []) {
    if (seen.has(t.id)) dup.add(t.id);
    seen.add(t.id);
  }
  return [...dup];
}

/** 下一个票号：取现有最大数字 +1，两位补零（不复用已删号；删票 = 改 out-of-scope） */
export function nextTicketId(tickets) {
  let max = 0;
  for (const t of Array.isArray(tickets) ? tickets : []) {
    const m = /^T-(\d+)$/.exec(String(t?.id ?? ''));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `T-${String(max + 1).padStart(2, '0')}`;
}

/** ticket：新建一张 open 票（标题/类型/问题缺失交给调用方 parse 后按新 fail 拒写） */
export function addTicket(tickets, spec = {}) {
  const list = Array.isArray(tickets) ? tickets : [];
  const given = oneLine(spec.id);
  const id = given ? given.toUpperCase() : nextTicketId(list);
  if (!DECISION_ID_RE.test(id)) throw actionErr('DEC_INVALID_ID', `DEC_INVALID_ID 票 ID 必须形如 T-01（收到：${given || '(空)'}）`);
  if (list.some((t) => t.id === id)) throw actionErr('DEC_DUP_ID', `DEC_DUP_ID 票 ID 已存在：${id}（文件未写）`);
  const t = emptyTicket(id, oneLine(spec.title) || null);
  t.type = oneLine(spec.type).toLowerCase() || null;
  t.status = 'open';
  t.question = oneLine(spec.question) || null;
  t.blocked_by = [...new Set(splitList(spec.blocked_by ?? '').map((s) => s.toUpperCase()))];
  t.links = [...new Set(splitList(spec.links ?? ''))];
  return [...list, t];
}

/** claim：open → claimed，记 claimed_by / claimed_at（只记录，不承诺独占） */
export function claimTicket(tickets, id, by, at) {
  const list = Array.isArray(tickets) ? tickets : [];
  const want = oneLine(id).toUpperCase();
  const t = list.find((x) => x.id === want);
  if (!t) throw actionErr('DEC_NOT_FOUND', `DEC_NOT_FOUND 没有这张票：${want || '(未给 id)'}`);
  if (t.status !== 'open') throw actionErr('DEC_STATE', `DEC_STATE 票 ${want} 当前 status=${t.status ?? '缺失'}；只有 open 能 claim`);
  const owner = oneLine(by);
  if (!owner) throw actionErr('DEC_FIELD_MISSING', 'DEC_FIELD_MISSING claim 需要 claimed_by（by 参数）', { field: 'claimed_by' });
  return list.map((x) => (x.id === want ? { ...x, status: 'claimed', claimed_by: owner, claimed_at: at } : x));
}

/** resolve：open/claimed → resolved / out-of-scope，写 resolution + resolved_at（claimed 记录保留） */
export function resolveTicket(tickets, id, { resolution, status = 'resolved', at } = {}) {
  const list = Array.isArray(tickets) ? tickets : [];
  const want = oneLine(id).toUpperCase();
  const t = list.find((x) => x.id === want);
  if (!t) throw actionErr('DEC_NOT_FOUND', `DEC_NOT_FOUND 没有这张票：${want || '(未给 id)'}`);
  if (!PENDING_STATUSES.includes(t.status)) throw actionErr('DEC_STATE', `DEC_STATE 票 ${want} 已是终态（${t.status ?? '缺失'}），不能重复 resolve`);
  const st = oneLine(status).toLowerCase() || 'resolved';
  if (!TERMINAL_STATUSES.includes(st)) throw actionErr('DEC_STATE', `DEC_STATE ticket_status 只能是 resolved / out-of-scope（收到：${st}）`);
  const res = oneLine(resolution);
  if (!res) throw actionErr('DEC_RESOLUTION_MISSING', 'DEC_RESOLUTION_MISSING resolve 需要 resolution（一句话决议；out-of-scope 写为什么不做）', { field: 'resolution' });
  return list.map((x) => (x.id === want ? { ...x, status: st, resolution: res, resolved_at: at } : x));
}
