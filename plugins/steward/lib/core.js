/**
 * 「口径」核心：把一句话变成可核对的口径卡，并把确认过的规定落到正确的 AGENTS.md。
 *
 * 设计原则：
 *   1. 单一来源 —— 规定正文只写进 AGENTS.md，台账只是索引（记录来源会话、落点、时间）。
 *   2. 不做判断 —— 这里只做能确定的事：找文件、找小节、查重、查冲突、列盲点。
 *      语义判断留给模型，缺口留给用户点选项。
 *   3. 可回退 —— 每次写入前备份到 ~/.dsh/steward/backups/。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const HOME = process.env.KOUJING_HOME || os.homedir();
export const DSH = path.join(HOME, '.dsh');
const STATE_DIR = path.join(DSH, 'koujing');
const LEDGER_FILE = path.join(STATE_DIR, 'ledger.json');
const BACKUP_DIR = path.join(STATE_DIR, 'backups');
// docs-lint 是工作区约定的门禁脚本，不属于本插件：按「环境变量 → 已登记工作区的 tools」探测，找不到就跳过。
const LINT = process.env.DSH_DOCS_LINT || '';
const REGISTRY = path.join(DSH, 'plugin-registry.md');

export const exists = (p) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
};
export const readText = (p) => fs.readFileSync(p, 'utf8');
export const ensureDir = (d) => fs.mkdirSync(d, { recursive: true });

// 时间一律本地（2026-11-03 用户口径）：不要 toISOString() 那种 UTC 写法。
const pad2 = (n) => String(n).padStart(2, '0');
/** 本地 `YYYY-MM-DD HH:mm`（台账 at / 展示用）。 */
export function localStamp(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
/** 本地 `YYYYMMDD`（台账 id 段用）。 */
export function localDateId(d = new Date()) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}
/** 本地 14 位 `YYYYMMDDHHmmss`（备份文件名用）。 */
export function localFileStamp(d = new Date()) {
  return `${localDateId(d)}${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}
/** 旧台账里存的 ISO(UTC) 时间 → 本地 `YYYY-MM-DD HH:mm`；已是本地格式原样返回。 */
export function toLocalTimeString(v) {
  if (typeof v !== 'string') return v;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : localStamp(d);
}

export function normalize(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[\s\u3000\p{P}\p{S}]/gu, '');
}

function bigrams(s) {
  const t = normalize(s);
  const out = new Set();
  if (!t) return out;
  if (t.length === 1) out.add(t);
  for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2));
  return out;
}

/** Dice 相似度，适合中文短句。 */
export function dice(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const x of A) if (B.has(x)) hit += 1;
  return (2 * hit) / (A.size + B.size);
}

// ---------------------------------------------------------------- 工作区与规则文件

export function workspaces() {
  const out = [];
  try {
    const j = JSON.parse(readText(path.join(DSH, 'storages', 'workspace.json')));
    for (const w of Object.values(j.tables?.workspaces ?? {})) {
      if (w?.path && exists(w.path)) out.push({ path: w.path, title: w.title || path.basename(w.path) });
    }
  } catch {
    /* 读不到就靠下面的兜底 */
  }
  if (process.env.KOUJING_ISOLATED === '1') return out;
  const fallback = [process.cwd()];
  for (const d of fallback) {
    if (exists(d) && !out.some((x) => x.path.toLowerCase() === d.toLowerCase())) {
      out.push({ path: d, title: path.basename(d) });
    }
  }
  return out;
}

export function ruleTargets() {
  const out = [{ scope: 'user', title: '用户级', file: path.join(DSH, 'AGENTS.md') }];
  for (const w of workspaces()) {
    out.push({ scope: 'workspace', title: w.title, wsPath: w.path, file: path.join(w.path, 'AGENTS.md') });
  }
  return out.filter((t) => exists(t.file));
}

export function headings(text) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  lines.forEach((line, i) => {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (m) out.push({ index: i, level: m[1].length, text: m[2] });
  });
  return out;
}

export function bullets(text) {
  const lines = String(text).split(/\r?\n/);
  const hs = headings(text);
  const out = [];
  lines.forEach((line, i) => {
    const m = /^\s*[-*]\s+(.+)$/.exec(line);
    if (!m) return;
    const h = [...hs].reverse().find((x) => x.index < i);
    out.push({ line: i + 1, heading: h?.text ?? '', text: m[1].trim() });
  });
  return out;
}

// ---------------------------------------------------------------- 落点判断

// 领域路由表：把「某类说法」映射到「某个已登记工作区」。
// 这属于个人 / 团队配置，不进包：存在 ~/.dsh/steward/domains.json 时以它为准，
// 格式见同目录 domains.example.json；不存在则只用中性兜底（下面 pickPlacement 的后半段）。
const DOMAINS_FILE = path.join(STATE_DIR, 'domains.json');

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function loadRoutes() {
  try {
    const j = JSON.parse(readText(DOMAINS_FILE));
    const list = Array.isArray(j) ? j : j?.routes;
    return (Array.isArray(list) ? list : [])
      .filter((r) => r && r.pattern && r.workspace)
      .map((r) => ({
        re: new RegExp(String(r.pattern), String(r.flags ?? 'i')),
        title: String(r.workspace),
        tag: String(r.tag ?? r.workspace),
      }));
  } catch {
    return [];
  }
}

export function pickPlacement(statement) {
  const s = String(statement ?? '');
  const ws = workspaces();
  const hit = loadRoutes().find((h) => h.re.test(s));
  if (hit) {
    const w = ws.find((x) => x.title.toLowerCase() === hit.title.toLowerCase());
    if (w) {
      return {
        scope: 'workspace',
        wsPath: w.path,
        wsTitle: w.title,
        file: path.join(w.path, 'AGENTS.md'),
        reason: `提到「${hit.tag}」，按 ~/.dsh/steward/domains.json 的路由表落到 ${w.title}`,
      };
    }
    return {
      scope: 'user',
      file: path.join(DSH, 'AGENTS.md'),
      reason: `提到「${hit.tag}」，但没找到名为 ${hit.title} 的工作区，暂按用户级；确认后可用 workspace 参数强制指定`,
      warn: `未找到工作区 ${hit.title}`,
    };
  }
  // 中性兜底：说法里直接点名了某个已登记工作区，就落到它。
  const named = ws.find(
    (w) => w.title && new RegExp(`(^|[^\\w-])${escapeRe(w.title)}([^\\w-]|$)`, 'i').test(s),
  );
  if (named) {
    return {
      scope: 'workspace',
      wsPath: named.path,
      wsTitle: named.title,
      file: path.join(named.path, 'AGENTS.md'),
      reason: `说法里直接点名了工作区「${named.title}」`,
    };
  }
  return {
    scope: 'user',
    file: path.join(DSH, 'AGENTS.md'),
    reason: '没提到具体工作区，按「换个工作区还成立吗」判为用户级（可用 workspace 参数强制指定）',
  };
}

const THEMES = [
  { h: /外传|上传|云端|数据/, s: /外传|上传|云端|网盘|图床|截图|发票|文件/ },
  { h: /账户|登录|账号/, s: /登录|账号|扫码|cookie|凭据|密码/i },
  { h: /卡点|汇报/, s: /卡点|歧义|停下|猜|汇报|不确定/ },
  { h: /录入|规则|口径/, s: /规则|规定|录入|口径|放哪/ },
  { h: /推理|档位/, s: /推理|档位|max|high|off|low/i },
  { h: /成本|上下文/, s: /成本|上下文|token|花费|步数/i },
  { h: /工具选择|市场/, s: /插件市场|现成|工具选择|市场|bundle/ },
  { h: /桌面/, s: /桌面|ocr|uia|窗口|截图/ },
  { h: /进程|窗口/, s: /进程|窗口|关掉|常驻|后台/ },
  { h: /profile|插件/, s: /profile|插件|快照|烟测|安装/ },
  { h: /排版|文档/, s: /排版|字体|边框|配色|装饰|文档|表格|ppt/i },
  { h: /会话|归档/, s: /归档|删除|sessions|attachments|会话/i },
  { h: /手册|索引/, s: /手册|索引|docs-lint|runbook/i },
  { h: /工作区/, s: /工作区|workspace/i },
];

export function pickSection(file, statement) {
  if (!exists(file)) return { heading: '其他', reason: '目标文件不存在，将新建' };
  const hs = headings(readText(file)).filter((h) => h.level === 2);
  if (!hs.length) return { heading: '其他', reason: '文件里没有二级标题' };
  const scored = hs
    .map((h) => {
      let score = dice(h.text, statement) * 0.8;
      if (THEMES.some((t) => t.h.test(h.text) && t.s.test(statement))) score += 0.7;
      return { h, score };
    })
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score < 0.2) return { heading: '其他', reason: '没有明显匹配的小节，落到「其他」' };
  return { heading: best.h.text, reason: `与「${best.h.text}」主题最近（相关度 ${best.score.toFixed(2)}）` };
}

// ---------------------------------------------------------------- 冲突 / 盲点 / 清单

export function findConflicts(statement, limit = 6) {
  const hits = [];
  for (const t of ruleTargets()) {
    let text = '';
    try {
      text = readText(t.file);
    } catch {
      continue;
    }
    for (const b of bullets(text)) {
      const score = dice(b.text, statement);
      if (score >= 0.3) hits.push({ ...b, file: t.file, scope: t.scope, title: t.title, score });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

const BLINDSPOTS = [
  {
    id: 'export',
    // 只认「发出去」的动作和目的地，不认名词：以前提到「表格 / 图片」就报外传，
    // 「把这份表格整理一下」这种纯本地任务也被标成数据外传，报多了就没人看。
    re: /上传|外发|分享|同步到|发送|传给|发到|发给|发我|发群|邮件|微信|群里|网盘|图床|云盘|对象存储|pastebin|贴出去/i,
    risk: '数据外传',
    why: '本机红线：除对话本身，任何内容文件都不许上云',
    question: '这些东西允许发到哪里？',
    fallback: '只留本机，不外传',
  },
  {
    id: 'irreversible',
    re: /删除|删掉|清理|覆盖|格式化|迁移|重命名|移动|批量改/,
    risk: '不可逆操作',
    why: '删了不一定能恢复，SSD + TRIM 尤其危险；会话附件（attachments）删掉会让引用过它的历史会话永久打不开',
    question: '要不要先备份？备份放哪？',
    fallback: '先备份到本机，再动',
  },
  {
    id: 'persistent',
    re: /常驻|定时|每天|每小时|开机|服务|守护|后台/,
    risk: '常驻项',
    why: '常驻要申报，且要能一句话停掉',
    question: '跑多勤、占什么资源、怎么停？',
    fallback: '先不建常驻，改手动触发',
  },
  {
    id: 'login',
    re: /登录|扫码|账号|cookie|授权/,
    risk: '登录态',
    why: '能动登录态的只有用户本人',
    question: '需要我复用哪个已登录的会话？',
    fallback: '只复用，不登出、不改密码',
  },
  {
    id: 'cost',
    re: /批量|很多|全部|所有|长流程|反复|每天/,
    risk: '成本 / 上下文',
    why: '花费 ≈ 步数 × 上下文长度，批量任务最容易失控',
    question: '大概多少条 / 多少轮？要不要拆批跑？',
    fallback: '后台 job 分批，每批报一次进度',
  },
  {
    id: 'profile',
    re: /插件|profile|安装|升级|bundle|重启/,
    risk: '插件 / profile 改动',
    why: '改完 profile 有静默失效史，必须快照 + 烟测',
    question: '要不要先在临时 profile 验证？',
    fallback: '先快照，再装，装完新会话烟测',
  },
  {
    id: 'format',
    re: /表格|文档|ppt|word|excel|排版|样式|配色|字体/i,
    risk: '交付物排版',
    why: '本机默认最简排版，不加装饰',
    question: '要装饰吗？还是能读就行？',
    fallback: '不加装饰，等线 11 / 默认样式',
  },
  {
    id: 'cross',
    // 去掉裸「桌面 / 手机」：「桌面文件」是本机文件，不是「在另一台机器上跑」；
    // 以前「别再动我的桌面文件」会误报平台差异，而真正要问的是窗口归属。
    re: /另一台|别的机器|远程|服务器|跨机器|换台|那台|手机上|异地/,
    risk: '平台差异',
    why: '路径、分辨率、时区、可用命令都可能不同',
    question: '在哪台机器上跑？路径还是原来那个吗？',
    fallback: '先报环境（路径 / 分辨率 / 版本）再动手',
  },
  {
    id: 'time',
    re: /定时|每天|几点|周期|轮询|等待/,
    risk: '时间与失败重试',
    why: '定时任务失败没人看着会静默停',
    question: '失败了要不要重试 / 通知？',
    fallback: '失败留日志，不自动重试',
  },
  {
    id: 'secret',
    re: /密码|密钥|token|secret|凭据/i,
    risk: '凭据存放',
    why: '凭据只留本机并收紧 ACL',
    question: '放哪个文件？要不要收紧权限？',
    fallback: '本地文件 + 收紧 ACL，不进任何仓库',
  },
  {
    id: 'process',
    re: /关掉|关闭窗口|杀(掉|进程)|结束进程|最小化|重启(桌面端|服务|电脑)|拉起|启动.{0,6}(窗口|程序|浏览器)/,
    risk: '进程 / 窗口归属',
    why: '我为你诊断拉起的窗口用完要关；你本来开着的窗口一律不动；常驻要先申报',
    question: '这些窗口 / 进程是本次临时拉的，还是你原来就开着的？',
    fallback: '只关本次为诊断拉起的，你的窗口和常驻服务不动',
  },
  {
    id: 'concurrent',
    re: /并行|并发|一起跑|多开|两个(会话|任务|job|窗口)|同时(改|动|跑|写)|同一(个|份)(文件|目录|服务)/,
    risk: '并发冲突',
    why: '两个 job / 会话同时动同一处，后写的会静默覆盖前面的',
    question: '会不会有另一个任务或会话同时在动同一个文件 / 服务？',
    fallback: '串行做，动手前确认没有别的 job 在跑',
  },
  {
    id: 'script',
    re: /\.ps1|\.cmd|\.bat|BOM|PowerShell|powershell|编码|乱码|smoke\.mjs|\.mjs/i,
    risk: '脚本编码 / 引擎差异',
    why: '改 .ps1 丢 BOM 会让 5.1 按 GBK 解析中文注释直接崩；5.1 读 UTF-8 JSON 还会吃掉结尾引号',
    question: '要 pwsh 和 powershell.exe 5.1 都跑一遍吗？BOM 保住了吗？',
    fallback: '改完补 BOM，两个引擎各 Parser::ParseFile 一次',
  },
];

const DIMENSIONS = {
  rule: [
    { id: 'trigger', label: '触发条件', question: '什么情况下这条规定生效？', fallback: '所有会话、所有工作区都生效' },
    { id: 'scope', label: '范围', question: '用户级还是某个工作区？', fallback: '按落点判断' },
    { id: 'action', label: '动作 / 禁止', question: '具体要做什么、不许做什么？', fallback: '按原文逐字执行' },
    { id: 'criterion', label: '判定口径', question: '什么算做到？反例是什么？', fallback: '按原文的字面意思，不看动机' },
    { id: 'check', label: '怎么验', question: '以后怎么检查它被违反了？（脚本 / grep / 看哪份输出）', fallback: '我按字面判断，发现问题当场报' },
    { id: 'exception', label: '例外', question: '什么情况可以不遵守？', fallback: '没有例外' },
    { id: 'effective', label: '生效时间', question: '立即生效，还是下次会话起？', fallback: '立即生效（下个会话读到）' },
    { id: 'conflict', label: '冲突处理', question: '和现有规则打架时以哪条为准？', fallback: '新规则优先，旧条目就地改掉' },
  ],
  requirement: [
    { id: 'goal', label: '目标', question: '这次到底要交付什么？', fallback: '按原文最直接的理解' },
    { id: 'input', label: '输入 / 素材', question: '用什么材料、从哪拿？', fallback: '用当前会话里已有的，不额外找' },
    { id: 'output', label: '输出形态', question: '文件、对话、还是改代码？放哪？', fallback: '当前工作区，文件名按内容取' },
    { id: 'accept', label: '验收标准', question: '怎么算做完？谁来验？', fallback: '我能自己跑一遍并给出证据' },
    { id: 'boundary', label: '不要什么', question: '有什么明确不要的？', fallback: '不额外加装饰、不加没要求的功能' },
    { id: 'priority', label: '优先级 / 时间', question: '急不急？和别的任务冲突时让谁？', fallback: '按到达顺序，先做完再做下一个' },
  ],
  project: [
    { id: 'goal', label: '目标与成功标准', question: '项目做成什么样算成功？', fallback: '能演示一遍核心链路' },
    { id: 'scope', label: '范围', question: '做什么、明确不做什么？', fallback: '只做能演示的最小闭环' },
    { id: 'deliverable', label: '交付物', question: '最后交什么？代码 / 文档 / 包？', fallback: '可运行的东西 + 一页说明' },
    { id: 'accept', label: '验收方式', question: '谁来验、怎么验？', fallback: '我自己跑一遍并留证据' },
    { id: 'depends', label: '依赖与前置', question: '依赖什么没到位的东西？', fallback: '先列出来，能绕就绕' },
    { id: 'risk', label: '风险与回滚', question: '最坏会坏到什么程度？怎么退？', fallback: '每步可回退，改前备份' },
    { id: 'perm', label: '权限 / 数据', question: '要动谁的账号、数据、文件？', fallback: '不动登录态，文件只留本机' },
    { id: 'env', label: '平台 / 环境', question: '跑在哪台机器、什么版本？', fallback: '当前这台，先报环境再动手' },
    { id: 'cost', label: '成本 / 时间', question: '大概多少步、多长时间、花多少？', fallback: '先按 20 步内估，超了先报' },
    { id: 'owner', label: '维护归属', question: '做完谁维护？出问题找谁？', fallback: '你维护，我留操作手册' },
  ],
};

/**
 * 「在立规矩」的强语气词表。
 *
 * 全插件只此一处规则语气判定：`detectKind` 用它建卡，pre-step 提醒也用它
 * （index.js 复用 `looksLikeRule`）。以前两套正则各写一遍，「以后必须 / 每次
 * 都要」只在建卡侧有，提醒侧没有，于是卡判对了却不弹提醒。
 *
 * 刻意不收裸「不要」「别」「都」：「不要加装饰」是请求，「都改一下」是任务，
 * 收进来会让每句普通需求都弹口径提醒。收的是「别再 / 不要再 / 不许再」这类
 * 明确的禁止口吻。
 */
const RULE_CUE =
  /记住|记一下|记下来|记着|以后都|以后要|^以后|以后(每次|所有|任何|凡|都要|必须|不许|不要|别|先)|今后|从现在开始|从现在起|往后都|一律|严禁|禁止|不许|不准|不许再|不准再|别再|不要再|不要乱|这条规定|新规矩|立个规矩|每次(都|要|必须)|(所有|任何|凡是).{0,12}(必须|不许|不要|一律|禁止)/;

/** 一句话是不是「在立规矩」。 */
export function looksLikeRule(s) {
  return RULE_CUE.test(String(s ?? ''));
}

export function detectKind(s) {
  const t = String(s ?? '');
  if (looksLikeRule(t)) return 'rule';
  if (/项目|搭建|开发|实现|做一个|搞一个|从零|方案|上线|迁移|重构/.test(t)) return 'project';
  return 'requirement';
}

export function checklist(kind, placement, statement) {
  const base = DIMENSIONS[kind] ?? DIMENSIONS.requirement;
  return base.map((d) => {
    const item = { id: d.id, label: d.label, question: d.question, fallback: d.fallback, status: 'missing', value: '' };
    if (d.id === 'scope') {
      item.status = 'given';
      item.value = placement.scope === 'user' ? '用户级（所有工作区）' : `${placement.wsTitle}（工作区级）`;
    }
    if (d.id === 'action' || d.id === 'goal') {
      item.status = 'given';
      item.value = '按原文';
    }
    if (d.id === 'trigger' && /每次|一律|都|所有|以后/.test(statement)) {
      item.status = 'given';
      item.value = '每次、所有情况都适用';
    }
    return item;
  });
}

export function blindspotsFor(statement, kind) {
  const hits = BLINDSPOTS.filter((b) => b.re.test(String(statement ?? '')));
  // 盲点表加了进程 / 并发 / 脚本三条，上限跟着抬一格；不抬的话「外传 + 不可逆 +
  // 常驻」同时命中时，新条目永远被截掉、等于没加。
  const picked = hits.slice(0, kind === 'project' ? 9 : 5);
  return picked.map((b) => ({ id: b.id, risk: b.risk, why: b.why, question: b.question, fallback: b.fallback }));
}

// ---------------------------------------------------------------- 台账

export function ledgerPath() {
  return LEDGER_FILE;
}

export function readLedger() {
  try {
    const j = JSON.parse(readText(LEDGER_FILE));
    if (!Array.isArray(j.entries)) j.entries = [];
    // 旧记录 at 是 ISO(UTC)，读时换成本地；新记录本来就是本地格式，原样保留。
    j.entries = j.entries.map((e) => ({ ...e, at: toLocalTimeString(e.at) }));
    return j;
  } catch {
    return { version: 1, entries: [] };
  }
}

function writeAtomic(file, text) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function saveLedger(ledger) {
  writeAtomic(LEDGER_FILE, `${JSON.stringify(ledger, null, 2)}\n`);
}

export function ledgerReport() {
  const ledger = readLedger();
  return ledger.entries.map((e) => {
    let found = null;
    if (exists(e.file)) {
      const text = readText(e.file);
      const normBody = normalize(e.body);
      for (const b of bullets(text)) {
        if (normalize(b.text).includes(normBody) || normBody.includes(normalize(b.text))) {
          found = { line: b.line, heading: b.heading };
          break;
        }
      }
    }
    return { ...e, found: Boolean(found), line: found?.line ?? null, heading: found?.heading ?? e.heading };
  });
}

// ---------------------------------------------------------------- 检索

export function searchRules(query, limit = 20) {
  const tokens = String(query ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map(normalize)
    .filter(Boolean);
  if (!tokens.length) return [];
  const files = [];
  for (const t of ruleTargets()) files.push({ file: t.file, scope: t.scope });
  if (exists(REGISTRY)) files.push({ file: REGISTRY, scope: 'registry' });
  for (const w of workspaces()) {
    try {
      for (const name of fs.readdirSync(w.path)) {
        if (/^PLAN-.*\.md$/i.test(name)) files.push({ file: path.join(w.path, name), scope: 'plan' });
      }
    } catch {
      /* 工作区读不到就跳过 */
    }
  }

  const hits = [];
  for (const f of files) {
    let text = '';
    try {
      text = readText(f.file);
    } catch {
      continue;
    }
    const hs = headings(text);
    String(text)
      .split(/\r?\n/)
      .forEach((line, i) => {
        const n = normalize(line);
        if (!n) return;
        let score = 0;
        for (const t of tokens) if (n.includes(t)) score += 1;
        if (!score) return;
        const h = [...hs].reverse().find((x) => x.index < i);
        hits.push({ file: f.file, scope: f.scope, line: i + 1, heading: h?.text ?? '', text: line.trim().slice(0, 240), score });
      });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ---------------------------------------------------------------- 写入

function backup(file) {
  if (!exists(file)) return null;
  ensureDir(BACKUP_DIR);
  const stamp = localFileStamp();
  const dest = path.join(BACKUP_DIR, `${path.basename(path.dirname(file))}-${path.basename(file)}-${stamp}.bak`);
  fs.copyFileSync(file, dest);
  return dest;
}

function runLint(file) {
  const lint = [LINT, ...workspaces().map((w) => path.join(w.path, 'tools', 'docs-lint.mjs'))].filter(Boolean).find(exists);
  if (!lint) return { skipped: 'docs-lint.mjs 不存在（可用 DSH_DOCS_LINT 指定）' };
  const under = [DSH, ...workspaces().map((w) => w.path)].some((d) =>
    path.resolve(file).toLowerCase().startsWith(path.resolve(d).toLowerCase()),
  );
  if (!under) return { skipped: '不在 docs-lint 覆盖范围' };
  const r = spawnSync(process.execPath, [lint, '--quiet'], { encoding: 'utf8', timeout: 120000, windowsHide: true });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split(/\r?\n/).filter(Boolean);
  return { ok: r.status === 0, code: r.status, tail: out.slice(-6).join('\n') };
}

/**
 * 把一条规定写进目标 AGENTS.md。
 * @returns {{status:string, file:string, heading?:string, lines?:number[], backup?:string|null, lint?:object, existing?:object}}
 */
export function commitRule({ title, body, scope, wsPath, section, session, tags }) {
  const cleanBody = String(body ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/^\s*[-*]\s+/, '')
    .trim();
  if (!cleanBody) throw new Error('body 不能为空');

  const file = scope === 'workspace'
    ? path.join(String(wsPath ?? ''), 'AGENTS.md')
    : path.join(DSH, 'AGENTS.md');
  if (scope === 'workspace' && !wsPath) throw new Error('scope=workspace 时必须给 wsPath');

  let text = exists(file) ? readText(file) : '# 工作区约定\n';
  const dup = bullets(text)
    .map((b) => ({ ...b, score: dice(b.text, cleanBody) }))
    .filter((b) => b.score >= 0.9)
    .sort((a, b) => b.score - a.score)[0];
  if (dup) {
    return { status: 'duplicate', file, heading: dup.heading, lines: [dup.line], existing: dup };
  }

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const wanted = String(section ?? '').trim();

  let hs = headings(text).filter((h) => h.level === 2);
  let head = wanted ? hs.find((h) => h.text === wanted || h.text.includes(wanted)) : undefined;
  // 显式点名的小节优先：点名的节不存在就按名新建，不要退回启发式——
  // 退回去会把规定塞进「看起来最像」的旧节里（2026-10-30 把「计划书格式」塞进了「推理档位」）。
  if (!head && !wanted) {
    const picked = pickSection(file, cleanBody);
    head = hs.find((h) => h.text === picked.heading);
  }
  if (!head) {
    const name = wanted || '其他';
    const block = ['', `## ${name}`, '', `- ${cleanBody}`];
    let out = lines.slice();
    while (out.length && out[out.length - 1].trim() === '') out.pop();
    out = [...out, ...block];
    const next = `${out.join(eol)}${eol}`;
    const bak = backup(file);
    writeAtomic(file, next);
    const ledger = readLedger();
    const entry = {
      id: `kj-${localDateId()}-${crypto.randomBytes(2).toString('hex')}`,
      title: String(title ?? cleanBody.slice(0, 40)),
      body: cleanBody,
      scope,
      file,
      heading: name,
      at: localStamp(),
      session: session ?? null,
      tags: Array.isArray(tags) ? tags : [],
    };
    ledger.entries.push(entry);
    saveLedger(ledger);
    const startLine = out.findIndex((l) => l === `- ${cleanBody}`) + 1;
    return { status: 'written', file, heading: name, lines: [startLine, startLine], backup: bak, lint: runLint(file), entry };
  }

  hs = headings(text).filter((h) => h.level === 2);
  const idx = hs.findIndex((h) => h.index === head.index);
  const sectionEnd = idx + 1 < hs.length ? hs[idx + 1].index : lines.length;
  const before = lines.slice(0, head.index + 1);
  const sectionBody = lines.slice(head.index + 1, sectionEnd);
  const after = lines.slice(sectionEnd);
  while (sectionBody.length && sectionBody[sectionBody.length - 1].trim() === '') sectionBody.pop();
  sectionBody.push('', `- ${cleanBody}`);
  const merged = [...before, ...sectionBody];
  const out = [...merged, '', ...after];
  while (out.length > 1 && out[out.length - 1].trim() === '' && out[out.length - 2].trim() === '') out.pop();
  const next = `${out.join(eol)}${eol}`;
  const bak = backup(file);
  writeAtomic(file, next);

  const startLine = out.indexOf(`- ${cleanBody}`) + 1;
  const ledger = readLedger();
  const entry = {
    id: `kj-${localDateId()}-${crypto.randomBytes(2).toString('hex')}`,
    title: String(title ?? cleanBody.slice(0, 40)),
    body: cleanBody,
    scope,
    file,
    heading: head.text,
    at: localStamp(),
    session: session ?? null,
    tags: Array.isArray(tags) ? tags : [],
  };
  ledger.entries.push(entry);
  saveLedger(ledger);

  return {
    status: 'written',
    file,
    heading: head.text,
    lines: [startLine, startLine],
    backup: bak,
    lint: runLint(file),
    entry,
  };
}
