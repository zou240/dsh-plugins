/**
 * 「口径」Client 半：设置页里的台账面板。
 * 数据来自 Host 注册的只读路由 /steward/ledger.json。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-steward',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useState } = React;

    const ZH = {
      title: '统筹项目与规则',
      subtitle: '台账 / 记录流 / 项目：你说过的长期规定、按时间串起的改动与计划、已登记项目的当前态。',
      search: '搜索标题、正文或路径',
      refresh: '刷新',
      empty: '还没有登记过规定。在对话里说一句长期有效的规定，我会先出卡、确认后再落库。',
      active: '在文件里',
      stale: '文件里已找不到',
      count: '条',
      updated: '更新于',
      error: '读取台账失败',
      retry: '重试',
      hostHint: '如果一直失败，可能是 Host 还没加载路由：重启桌面端后再试。',
      scopeUser: '用户级',
      scopeWorkspace: '工作区',
      none: '（无标题）',
      tabLedger: '台账',
      tabTimeline: '记录流',
      tlTitle: '记录流',
      tlSubtitle: '把以往的改动、报错、计划按时间串起来；来源是插件台账 D7/D8、PLAN 与规则台账。',
      tlEmpty: '还没有可串联的记录。',
      tlThreads: '主线',
      tlCount: '条记录',
      tabProjects: '项目',
      pjTitle: '项目档案',
      pjSubtitle: '已登记项目的当前态：真源、状态、最后更新与指针健康度（只读；写入用 steward_project / steward_handoff）。',
      pjCount: '个项目',
      pjEmpty: '还没有登记项目。用 steward_project action=register 建档。',
      pjBroken: 'projects.json 解析失败：写操作会被拒绝，先修复或恢复备份。',
      pjSourceMissing: '源目录不在',
      pjStatusMissing: 'STATUS 未生成',
      pjStatusForeign: 'statusFile 不是 STATUS.md',
      pjPlanMissing: '计划文件不在',
      pjClosed: '已收尾',
    };
    const EN = {
      title: 'Project & Rules Steward',
      subtitle: 'Ledger / Stream / Projects: standing rules, a dated timeline of changes and plans, and the registered projects.',
      search: 'Search title, text, or path',
      refresh: 'Refresh',
      empty: 'Nothing registered yet. State a standing rule in chat and I will show a card first, then write it.',
      active: 'In file',
      stale: 'Missing from file',
      count: 'entries',
      updated: 'Updated',
      error: 'Failed to read the ledger',
      retry: 'Retry',
      hostHint: 'If this keeps failing, the Host route may not be loaded yet: restart the desktop app and retry.',
      scopeUser: 'User level',
      scopeWorkspace: 'Workspace',
      none: '(untitled)',
      tabLedger: 'Ledger',
      tabTimeline: 'Stream',
      tlTitle: 'Record stream',
      tlSubtitle: 'Changes, errors, and plans threaded by date; sourced from plugin registry D7/D8, PLAN files, and the rule ledger.',
      tlEmpty: 'No records to thread yet.',
      tlThreads: 'Threads',
      tlCount: 'records',
      tabProjects: 'Projects',
      pjTitle: 'Project registry',
      pjSubtitle: 'Current state of registered projects: source, status, last update, pointer health (read-only; writes go through steward_project / steward_handoff).',
      pjCount: 'projects',
      pjEmpty: 'No projects registered yet. Use steward_project action=register.',
      pjBroken: 'projects.json failed to parse: writes are refused until it is repaired or restored from backup.',
      pjSourceMissing: 'source missing',
      pjStatusMissing: 'STATUS not generated',
      pjStatusForeign: 'statusFile is not a STATUS.md',
      pjPlanMissing: 'plan file missing',
      pjClosed: 'closed',
    };

    const S = {
      wrap: { padding: '20px 22px', maxWidth: 760, color: 'var(--dsw-alias-label-primary)', fontSize: 13 },
      head: { display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 },
      title: { fontSize: 15, fontWeight: 600, margin: 0 },
      count: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 },
      sub: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, margin: '0 0 14px' },
      bar: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 },
      input: {
        flex: 1,
        height: 30,
        padding: '0 10px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 12,
        outline: 'none',
      },
      btn: {
        height: 30,
        padding: '0 12px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 12,
        cursor: 'pointer',
      },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        borderRadius: 10,
        padding: '10px 12px',
        marginBottom: 8,
        cursor: 'pointer',
      },
      rowTop: { display: 'flex', alignItems: 'center', gap: 8 },
      dot: { width: 7, height: 7, borderRadius: 4, flex: '0 0 auto' },
      name: { fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      meta: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, marginTop: 3 },
      body: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, marginTop: 6, lineHeight: 1.55 },
      path: {
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
        fontSize: 11,
        color: 'var(--dsw-alias-label-tertiary)',
        marginTop: 6,
        wordBreak: 'break-all',
      },
      empty: {
        border: '1px dashed var(--dsw-alias-border-l1)',
        borderRadius: 10,
        padding: '28px 18px',
        textAlign: 'center',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 12,
        lineHeight: 1.7,
      },
      error: {
        border: '1px solid var(--dsw-alias-state-error-primary)',
        borderRadius: 8,
        padding: '10px 12px',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 12,
        marginBottom: 10,
      },
    };

    function makeTranslator(ctx) {
      let tr = null;
      try {
        ctx.locale.register('koujing', { zh: ZH, en: EN });
        tr = ctx.locale.bind('koujing');
      } catch {
        tr = null;
      }
      return (key) => {
        try {
          const v = tr ? tr(key) : undefined;
          if (typeof v === 'string' && v && v !== key) return v;
        } catch {
          /* 落到内置中文 */
        }
        return ZH[key] ?? key;
      };
    }

    function useTranslator(ctx) {
      const [t, setT] = useState(() => makeTranslator(ctx));
      useEffect(() => {
        try {
          return ctx.locale.subscribe(() => setT(() => makeTranslator(ctx)));
        } catch {
          return undefined;
        }
      }, [ctx]);
      return t;
    }

    function shortDate(iso) {
      return typeof iso === 'string' ? iso.slice(0, 10) : '';
    }

    function Card({ row, t }) {
      const [open, setOpen] = useState(false);
      const dotColor = row.found ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-warn-primary)';
      const scope = row.scope === 'workspace' ? t('scopeWorkspace') : t('scopeUser');
      const meta = [scope, shortDate(row.at), row.heading ? `## ${row.heading}` : ''].filter(Boolean).join(' · ');
      return h(
        'div',
        {
          style: { ...S.card, ...(open ? { background: 'var(--dsw-alias-bg-layer-2)' } : {}) },
          onClick: () => setOpen((v) => !v),
          title: open ? '收起' : '展开',
        },
        h(
          'div',
          { style: S.rowTop },
          h('span', { style: { ...S.dot, background: dotColor } }),
          h('span', { style: S.name }, row.title || t('none')),
          h('span', { style: { marginLeft: 'auto', color: 'var(--dsw-alias-label-tertiary)', fontSize: 11 } }, row.found ? t('active') : t('stale')),
        ),
        h('div', { style: S.meta }, meta),
        h(
          'div',
          {
            style: open
              ? S.body
              : { ...S.body, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          },
          row.body,
        ),
        h('div', { style: S.path }, `${row.file}${row.line ? `:${row.line}` : ''}`),
        open && row.session
          ? h('div', { style: { ...S.meta, marginTop: 4 } }, `来源会话：${row.session}`)
          : null,
      );
    }

    function Panel({ ctx }) {
      const t = useTranslator(ctx);
      const [state, setState] = useState({ loading: true, error: null, rows: [], at: null });
      const [q, setQ] = useState('');

      const load = useCallback(() => {
        setState((prev) => ({ ...prev, loading: true, error: null }));
        fetch('/steward/ledger.json', { cache: 'no-store' })
          .then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
          })
          .then((j) => setState({ loading: false, error: null, rows: Array.isArray(j.entries) ? j.entries : [], at: j.generatedAt ?? null }))
          .catch((e) => setState({ loading: false, error: String(e?.message ?? e), rows: [], at: null }));
      }, []);

      useEffect(() => {
        load();
      }, [load]);

      const rows = useMemo(() => {
        const key = q.trim().toLowerCase();
        if (!key) return state.rows;
        return state.rows.filter((r) =>
          [r.title, r.body, r.heading, r.file].some((v) => typeof v === 'string' && v.toLowerCase().includes(key)),
        );
      }, [state.rows, q]);

      return h(
        'div',
        { style: S.wrap },
        h(
          'div',
          { style: S.head },
          h('h2', { style: S.title }, t('title')),
          h('span', { style: S.count }, `${rows.length} / ${state.rows.length} ${t('count')}`),
          state.at ? h('span', { style: { ...S.count, marginLeft: 'auto' } }, `${t('updated')} ${state.at.replace('T', ' ').slice(0, 19)}`) : null,
        ),
        h('p', { style: S.sub }, t('subtitle')),
        h(
          'div',
          { style: S.bar },
          h('input', {
            style: S.input,
            value: q,
            placeholder: t('search'),
            onChange: (e) => setQ(e.target.value),
          }),
          h('button', { style: S.btn, onClick: load, disabled: state.loading }, state.loading ? '…' : t('refresh')),
        ),
        state.error
          ? h(
              'div',
              { style: S.error },
              h('div', null, `${t('error')}：${state.error}`),
              h('div', { style: { ...S.meta, marginTop: 6 } }, t('hostHint')),
              h('button', { style: { ...S.btn, marginTop: 8 }, onClick: load }, t('retry')),
            )
          : null,
        rows.length
          ? rows.map((row) => h(Card, { key: row.id, row, t }))
          : state.loading
            ? null
            : h('div', { style: S.empty }, t('empty')),
      );
    }

    function Timeline({ ctx }) {
      const t = useTranslator(ctx);
      const [state, setState] = useState({ loading: true, error: null, tl: null });
      const load = useCallback(() => {
        setState((prev) => ({ ...prev, loading: true, error: null }));
        fetch('/steward/timeline.json', { cache: 'no-store' })
          .then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
          })
          .then((j) => setState({ loading: false, error: null, tl: j }))
          .catch((e) => setState({ loading: false, error: String(e?.message ?? e), tl: null }));
      }, []);
      useEffect(() => {
        load();
      }, [load]);

      const tl = state.tl;
      const days = useMemo(() => {
        if (!tl?.events) return [];
        const map = new Map();
        for (const e of tl.events) {
          if (!map.has(e.at)) map.set(e.at, []);
          map.get(e.at).push(e);
        }
        return [...map.entries()];
      }, [tl]);

      return h(
        'div',
        { style: S.wrap },
        h(
          'div',
          { style: S.head },
          h('h2', { style: S.title }, t('tlTitle')),
          tl ? h('span', { style: S.count }, `${tl.total} ${t('tlCount')}`) : null,
          tl ? h('span', { style: { ...S.count, marginLeft: 'auto' } }, `${tl.range.from ?? '—'} → ${tl.range.to ?? '—'}`) : null,
        ),
        h('p', { style: S.sub }, t('tlSubtitle')),
        h(
          'div',
          { style: S.bar },
          h('button', { style: S.btn, onClick: load, disabled: state.loading }, state.loading ? '…' : t('refresh')),
        ),
        state.error
          ? h(
              'div',
              { style: S.error },
              h('div', null, `${t('error')}：${state.error}`),
              h('button', { style: { ...S.btn, marginTop: 8 }, onClick: load }, t('retry')),
            )
          : null,
        tl && tl.threads.length
          ? h(
              'div',
              { style: { ...S.card, cursor: 'default', marginBottom: 14 } },
              h('div', { style: S.meta }, t('tlThreads')),
              ...tl.threads.map((th) =>
                h(
                  'div',
                  { key: th.id, style: { fontSize: 12, marginTop: 5, color: 'var(--dsw-alias-label-secondary)' } },
                  h('strong', { style: { color: 'var(--dsw-alias-label-primary)' } }, th.name),
                  ` · ${th.count} 条 · ${th.first} → ${th.last}`,
                ),
              ),
            )
          : null,
        days.map(([day, list]) =>
          h(
            'div',
            { key: day },
            h('div', { style: { ...S.meta, margin: '16px 0 6px', fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' } }, day),
            ...list.map((e, i) =>
              h(
                'div',
                {
                  key: `${day}-${i}`,
                  style: {
                    ...S.card,
                    cursor: 'default',
                    borderLeft: e.kind === 'error' ? '3px solid var(--dsw-alias-state-error-primary)' : '3px solid var(--dsw-alias-border-l2)',
                  },
                },
                h('div', { style: S.name }, `${e.subject ? `${e.subject} · ` : ''}${e.title}`),
                e.detail ? h('div', { style: S.body }, e.detail) : null,
                e.source ? h('div', { style: S.meta }, e.source) : null,
              ),
            ),
          ),
        ),
        !tl && !state.loading && !state.error ? h('div', { style: S.empty }, t('tlEmpty')) : null,
      );
    }

    function Projects({ ctx }) {
      const t = useTranslator(ctx);
      const [state, setState] = useState({ loading: true, error: null, data: null });
      const load = useCallback(() => {
        setState((prev) => ({ ...prev, loading: true, error: null }));
        fetch('/steward/projects.json', { cache: 'no-store' })
          .then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
          })
          .then((j) => setState({ loading: false, error: null, data: j }))
          .catch((e) => setState({ loading: false, error: String(e?.message ?? e), data: null }));
      }, []);
      useEffect(() => {
        load();
      }, [load]);

      const list = state.data?.projects ?? [];
      const flagsOf = (p) => {
        const f = [];
        if (!p.health?.sourceOk) f.push(t('pjSourceMissing'));
        if (p.health?.statusState === 'missing') f.push(t('pjStatusMissing'));
        if (p.health?.statusState === 'foreign') f.push(t('pjStatusForeign'));
        if (p.health?.planOk === false) f.push(t('pjPlanMissing'));
        if (p.health?.closed) f.push(t('pjClosed'));
        return f;
      };

      return h(
        'div',
        { style: S.wrap },
        h(
          'div',
          { style: S.head },
          h('h2', { style: S.title }, t('pjTitle')),
          list.length ? h('span', { style: S.count }, `${list.length} ${t('pjCount')}`) : null,
        ),
        h('p', { style: S.sub }, t('pjSubtitle')),
        h(
          'div',
          { style: S.bar },
          h('button', { style: S.btn, onClick: load, disabled: state.loading }, state.loading ? '…' : t('refresh')),
        ),
        state.data?.broken ? h('div', { style: S.error }, t('pjBroken')) : null,
        state.error ? h('div', { style: S.error }, `${t('error')}：${state.error}`) : null,
        list.length
          ? list.map((p) => {
              const flags = flagsOf(p);
              return h(
                'div',
                { key: p.key, style: { ...S.card, cursor: 'default' } },
                h('div', { style: S.name }, `${p.title} · ${p.key}`),
                h(
                  'div',
                  { style: S.meta },
                  `${p.status}${p.updated ? ` · ${t('updated')} ${p.updated}` : ''}`,
                ),
                h('div', { style: S.body }, p.source || ''),
                flags.length
                  ? h(
                      'div',
                      { style: { ...S.meta, color: 'var(--dsw-alias-state-error-primary)' } },
                      `⚠ ${flags.join(' · ')}`,
                    )
                  : h('div', { style: S.meta }, '✓'),
              );
            })
          : !state.loading && !state.error
            ? h('div', { style: S.empty }, t('pjEmpty'))
            : null,
      );
    }

    function Shell(props) {
      const [tab, setTab] = useState('ledger');
      const t = useTranslator(props.ctx);
      const tabBtn = (id, label) =>
        h(
          'button',
          {
            key: id,
            onClick: () => setTab(id),
            style: {
              ...S.btn,
              background: tab === id ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
              borderColor: tab === id ? 'var(--dsw-alias-border-l2)' : 'transparent',
              fontWeight: tab === id ? 600 : 400,
            },
          },
          label,
        );
      return h(
        'div',
        null,
        h(
          'div',
          { style: { display: 'flex', gap: 6, padding: '18px 22px 0' } },
          tabBtn('ledger', t('tabLedger')),
          tabBtn('timeline', t('tabTimeline')),
          tabBtn('projects', t('tabProjects')),
        ),
        tab === 'ledger' ? h(Panel, props) : tab === 'timeline' ? h(Timeline, props) : h(Projects, props),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // 先把词条注册上：设置导航的 label 在面板渲染之前就会解析，
        // 晚注册只能拿到 key（曾显示字面量 "title"）。
        try {
          ctx.locale.register('koujing', { zh: ZH, en: EN });
        } catch {
          /* locale 不可用就退回内置中文 */
        }
        const label = () => {
          try {
            const v = ctx.locale.bind('koujing')('title');
            if (typeof v === 'string' && v && v !== 'title') return v;
          } catch {
            /* 落到内置中文 */
          }
          return ZH.title;
        };
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'koujing',
              order: 510,
              label,
            },
            (props) => h(Shell, { ...props, ctx }),
          ),
        );
      },
    };
  },
});
