/**
 * 改动账本：把一次改动写成 `~/.dsh/CHANGES.md` 的一行，并可选把某项目 `STATUS.md` 的「最后更新」戳成当前时间。
 *
 * 为什么单独一层：规则台账（ledger.json）只管「口径」，计划只管「项目进度」，
 * 两者都不回答「这次到底改了哪些文件/插件/工具」；时间线需要这层才能跨会话读到已实现的改动。
 *
 * 表格列（0.2.2 起）：日期 | 类型 | 对象 | 改了什么 | 证据 | 回滚 | 指针
 * 类型：改动 / 报错 / 决策 / 运行。读取按表头列名映射，旧 6 列文件也能读（缺「类型」按「改动」）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DSH, exists, readText } from './core.js';

export const CHANGES_FILE = path.join(DSH, 'CHANGES.md');
export const CHANGE_TYPES = ['改动', '报错', '决策', '运行'];

const TITLE = '# 改动账本（全工作区唯一一份）';
const NOTE = [
  '> 用途：任何会话、任何工作区，改动了项目/插件/工具/规则/文档，都往这张表**追加一行**；新会话接手先看最近 10 行 + 对应项目的 `STATUS.md`。',
  '> 门禁：`D:\\dsh\\tools\\gate.cmd`（改动是否都登记 + STATUS 是否新鲜 → docs-lint 查断链），两条都 0 才算过。',
  '> 列固定：**日期 | 类型 | 对象 | 改了什么 | 证据 | 回滚 | 指针**；「类型」= 改动 / 报错 / 决策 / 运行，「对象」用 change-gate 配置里的 key。',
  '',
  '| 日期 | 类型 | 对象 | 改了什么 | 证据 | 回滚 | 指针 |',
  '|---|---|---|---|---|---|---|',
];

const pad = (n) => String(n).padStart(2, '0');

/** 本地时间戳 `YYYY-MM-DD HH:mm`（不要 UTC）。 */
export function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const cell = (s) =>
  String(s ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .replace(/\s+/g, ' ')
    .trim();

function splitRow(line) {
  return line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim().replace(/\\\|/g, '|'));
}

/** 表头列名 → 下标；拿不到就退回 0.2.1 的固定顺序。 */
function headerMap(lines) {
  const i = lines.findIndex((l) => /^\|\s*日期\s*\|/.test(l));
  if (i < 0) return null;
  const names = splitRow(lines[i]);
  const map = {};
  names.forEach((n, idx) => { map[n] = idx; });
  return map;
}

/** 账本不存在时建表头；返回是否新建。 */
export function ensureChangesFile() {
  if (exists(CHANGES_FILE)) return false;
  fs.mkdirSync(DSH, { recursive: true });
  fs.writeFileSync(CHANGES_FILE, [TITLE, '', ...NOTE].join('\n') + '\n', 'utf8');
  return true;
}

/** 解析已有账本行（跳过表头与分隔行）；兼容旧 6 列。 */
export function listChanges(limit = 20) {
  if (!exists(CHANGES_FILE)) return [];
  const lines = readText(CHANGES_FILE).split(/\r?\n/);
  const map = headerMap(lines);
  const rows = [];
  for (const line of lines) {
    if (!/^\|\s*20\d\d-\d\d-\d\d/.test(line)) continue;
    const c = splitRow(line);
    if (map) {
      rows.push({
        at: c[map['日期']] ?? '',
        type: c[map['类型']] ?? '改动',
        object: c[map['对象']] ?? '',
        change: c[map['改了什么']] ?? '',
        evidence: c[map['证据']] ?? '',
        rollback: c[map['回滚']] ?? '',
        pointer: c[map['指针']] ?? '',
      });
    } else {
      rows.push({ at: c[1] ?? '', type: '改动', object: c[2] ?? '', change: c[3] ?? '', evidence: c[4] ?? '', rollback: c[5] ?? '', pointer: c[6] ?? '' });
    }
  }
  // 按时间排序（补录行可能插在表头下，文件顺序 ≠ 时间顺序）
  rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return limit > 0 ? rows.slice(-limit) : rows;
}

/**
 * 追加一行。
 * @param {object} p
 * @param {string} p.object   对象 key（多个用空格分隔）
 * @param {string} p.change   改了什么（必填）
 * @param {string} [p.type]   改动 / 报错 / 决策 / 运行（默认「改动」）
 * @param {string} [p.evidence] 证据
 * @param {string} [p.rollback] 回滚方式
 * @param {string} [p.pointer]  关联指针
 * @param {string} [p.at]       覆盖日期（'YYYY-MM-DD HH:mm'）
 * @param {string} [p.status]   可选：同时把该 STATUS.md 的「最后更新」戳成现在
 */
export function appendChange(p = {}) {
  const object = cell(p.object);
  const change = cell(p.change);
  if (!object) throw new Error('object 不能为空（如 ego-merged / rules-user / tools-dsh）');
  if (!change) throw new Error('change 不能为空（一句话写清改了什么）');
  const type = cell(p.type) || '改动';
  if (!CHANGE_TYPES.includes(type)) throw new Error(`type 只能是 ${CHANGE_TYPES.join(' / ')}`);
  const created = ensureChangesFile();
  const at = p.at ? String(p.at).trim() : stamp();
  const line = `| ${at} | ${type} | ${object} | ${change} | ${cell(p.evidence)} | ${cell(p.rollback)} | ${cell(p.pointer)} |`;
  fs.writeFileSync(CHANGES_FILE, readText(CHANGES_FILE).replace(/\s*$/, '\n') + line + '\n', 'utf8');
  const lineNo = readText(CHANGES_FILE).split(/\r?\n/).lastIndexOf(line) + 1;

  let status = null;
  if (p.status) {
    const f = String(p.status);
    if (!exists(f)) {
      status = { ok: false, file: f, note: 'STATUS 文件不存在' };
    } else {
      const old = readText(f);
      const now = at.includes(':') ? at : stamp();
      if (/最后更新[：:]\s*\d{4}-\d\d-\d\d[ T]\d\d:\d\d/.test(old)) {
        fs.writeFileSync(f, old.replace(/(最后更新[：:]\s*)\d{4}-\d\d-\d\d[ T]\d\d:\d\d/, `$1${now}`), 'utf8');
        status = { ok: true, file: f, at: now };
      } else {
        status = { ok: false, file: f, note: '文件里没有「最后更新：YYYY-MM-DD HH:mm」行，未改动' };
      }
    }
  }

  return { file: CHANGES_FILE, line, lineNo, created, status };
}
