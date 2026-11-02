/**
 * 项目日志：`~/.dsh/logs/<项目 key>.md`，一条一个块（时间 + 类型 + 正文）。
 * 与 `CHANGES.md` 的分工：
 *   - CHANGES = 改动/决策/报错的「一行摘要」，随时追加，供门禁与时间线读；
 *   - logs    = 单个项目的「过程日志」：运行输出、报错原文、决策理由、待办变化，块状可长。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DSH, exists, readText } from './core.js';

const LOG_DIR = path.join(DSH, 'logs');
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

const safeKey = (s) => String(s ?? '').trim().replace(/[\\/:*?"<>|\s]+/g, '-');
export const logFile = (key) => path.join(LOG_DIR, `${safeKey(key)}.md`);

export function ensureLogFile(key) {
  const f = logFile(key);
  if (exists(f)) return { file: f, created: false };
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(f, `# 项目日志 · ${key}\n\n> 由 steward_log 追加；每条以「## 时间 [类型]」开头。\n`, 'utf8');
  return { file: f, created: true };
}

export function appendLog({ project, text, type = '运行', at } = {}) {
  if (!project) throw new Error('project 不能为空（项目 key）');
  if (!text) throw new Error('text 不能为空');
  const { file, created } = ensureLogFile(project);
  const head = `## ${at || stamp()} [${type}]`;
  fs.appendFileSync(file, `\n${head}\n${String(text).replace(/\r?\n+$/, '')}\n`, 'utf8');
  return { file, created, head };
}

export function listLogs(project, limit = 20) {
  const f = logFile(project);
  if (!exists(f)) return [];
  const blocks = [];
  let cur = null;
  for (const line of readText(f).split(/\r?\n/)) {
    const m = line.match(/^##\s+(\d{4}-\d\d-\d\d \d\d:\d\d)\s+\[([^\]]+)\]/);
    if (m) {
      if (cur) blocks.push(cur);
      cur = { at: m[1], type: m[2], body: [] };
    } else if (cur) {
      cur.body.push(line);
    }
  }
  if (cur) blocks.push(cur);
  const out = blocks.map((b) => ({ at: b.at, type: b.type, text: b.body.join('\n').trim() }));
  return limit > 0 ? out.slice(-limit) : out;
}

/** 供时间线用：所有项目日志按时间并入。 */
export function allLogs(limit = 200) {
  if (!exists(LOG_DIR)) return [];
  const out = [];
  for (const name of fs.readdirSync(LOG_DIR)) {
    if (!name.endsWith('.md')) continue;
    const project = name.replace(/\.md$/, '');
    for (const l of listLogs(project, 0)) out.push({ ...l, project });
  }
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-limit);
}
