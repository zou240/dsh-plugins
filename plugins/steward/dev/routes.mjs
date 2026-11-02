/**
 * 只读路由的准入测试：不启动宿主，直接给 apply() 一个假 ctx。
 * 用法：node dev/routes.mjs
 *
 * 覆盖三条：无 connection 服务照常 200、connection 拒绝时两条路由一致 401、放行时 200。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.join(HERE, '.home-routes');
const DSH = path.join(HOME, '.dsh');

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(path.join(DSH, 'koujing'), { recursive: true });
fs.writeFileSync(path.join(DSH, 'AGENTS.md'), '# 用户级约定\n\n## 示例\n\n- 示例规则。\n', 'utf8');
fs.writeFileSync(path.join(DSH, 'koujing', 'ledger.json'), JSON.stringify({ version: 1, entries: [] }), 'utf8');

process.env.KOUJING_HOME = HOME;
process.env.KOUJING_ISOLATED = '1';

const { apply } = await import('../index.js');

const registered = [];
const toolNames = [];
const sections = [];
let connection;

const makeRes = () => ({
  statusCode: 0,
  headers: {},
  body: '',
  setHeader(k, v) {
    this.headers[k] = v;
  },
  end(chunk) {
    if (chunk !== undefined) this.body = String(chunk);
  },
});

const webCtx = {
  effect: (fn) => fn(),
  webServer: {
    register: (r) => {
      registered.push(r);
      return () => {};
    },
  },
  get: (name) => (name === 'connection' ? connection : undefined),
  logger: { info() {}, warn() {} },
};

const systemPrompt = {
  section: (s) => {
    sections.push(s);
    return () => {};
  },
  getSectionOrder: () => 100,
};

const ctx = {
  effect: (fn) => fn(),
  tools: {
    register: (t) => {
      toolNames.push(t.name);
    },
  },
  get: (name) => (name === 'systemPrompt' ? systemPrompt : undefined),
  inject: (names, cb) => {
    if (names.includes('webServer')) cb(webCtx);
  },
  on: () => {},
  logger: { info() {}, warn() {} },
};

apply(ctx);

const out = [];
const ok = (name, cond, extra = '') => out.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`);

ok('注册了三条只读路由', registered.length === 3, registered.map((r) => r.path).join(', '));
const NEW_TOOLS = ['card', 'plan', 'commit', 'search', 'ledger', 'change', 'project', 'handoff', 'log', 'timeline'];
const oldNames = NEW_TOOLS.map((n) => `koujing_${n}`);
const newNames = NEW_TOOLS.map((n) => `steward_${n}`);
ok(
  '注册了十个工具 + 十个旧名别名',
  toolNames.length === 20 && newNames.every((n) => toolNames.includes(n)) && oldNames.every((n) => toolNames.includes(n)),
  `${toolNames.length} 个：${toolNames.join(', ')}`,
);

const wantLang = String(process.env.KOUJING_POLICY_LANG ?? '').toLowerCase() === 'en' ? 'en' : 'zh';
const wantHead = wantLang === 'zh' ? '## 规则纪律' : '## Rule discipline';
ok(
  `注入小节是${wantLang === 'zh' ? '中文' : '英文'}版（${wantHead}）`,
  sections.length === 1 && sections[0].text.startsWith(wantHead),
  sections[0]?.text.split('\n')[0] ?? '(none)',
);

// 1 宿主没提供 connection 服务：照常返回 200 + JSON
for (const route of registered) {
  const res = makeRes();
  route.handler({}, res);
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    /* 下面会判 */
  }
  ok(`${route.path} 无准入服务→200`, res.statusCode === 200 && json !== null, `status=${res.statusCode}`);
}

// 2 connection 拒绝：三条路由必须一致地拒绝（timeline 曾漏加这关）
connection = { requestRejection: () => 401 };
for (const route of registered) {
  const res = makeRes();
  route.handler({}, res);
  ok(
    `${route.path} 拒绝时→401 且无正文`,
    res.statusCode === 401 && res.body === '',
    `status=${res.statusCode} body=${res.body.slice(0, 40)}`,
  );
}

// 3 connection 放行（返回 undefined）：200
connection = { requestRejection: () => undefined };
for (const route of registered) {
  const res = makeRes();
  route.handler({}, res);
  ok(`${route.path} 放行→200`, res.statusCode === 200, `status=${res.statusCode}`);
}

console.log(out.join('\n'));
process.exit(out.some((l) => l.startsWith('FAIL')) ? 1 : 0);
