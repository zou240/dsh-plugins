# Project & Rules Steward (dsh-plugin-steward)

Turn a one-line requirement into a checkable **rule card** and write it into the right `AGENTS.md` — plus project plans, a rule ledger, cross-file search and a timeline. Everything it produces is plain markdown: diffable, reviewable, portable.

> Terminology: the card is called a "rule card" in user-facing text; the `steward_card` tool still returns the Chinese term 「口径卡」 for the same thing. Tool output was deliberately left untouched so existing habits keep working.

## What it solves

1. You said "always do it this way" a week ago and can no longer remember the rule — it only ever lived in the chat.
2. A project spans several days, and you want to resume yesterday's progress instead of re-explaining it.
3. You want another tool or a teammate to read your conventions — they cannot open a plugin database, only plain text.

## Quick start

The npm package is not published yet; install from the repository:

```bash
git clone https://github.com/zou240/dsh-plugins
dsh plugin add ./dsh-plugins/plugins/steward
```

Start a new session and say "always give me the conclusion first". The model shows a card, asks every open question in one round, then writes the rule into `~/.dsh/AGENTS.md`.

Optional: map phrases to one of your workspaces so placement suggestions get sharper — copy `domains.example.json` to `~/.dsh/steward/domains.json` and edit. Without it the plugin works too: if the statement names a registered workspace it routes there, otherwise it falls back to user level.

## The six tools

| Tool | What it does / when to use it |
|---|---|
| `steward_card` | Splits a one-line requirement into the questions that must be settled, suggests which `AGENTS.md` and which section it belongs to, and lists matching existing rules, suspected conflicts and the blind spot people usually miss. Use it first: **no file edits, no conclusions**. |
| `steward_commit` | Writes a confirmed rule into the target `AGENTS.md`: dedupe, back up, record the ledger entry, optionally run your own `docs-lint` gate, then report file and line numbers. |
| `steward_plan` | Project plans: `save` writes `PLAN-*.md` in the workspace root (6 mandatory sections, optional gap/mode sections), `get` / `list` read them, `update` ticks steps and logs progress. Update semantics are `merge` / `append` / `replace`; the default `merge` never wipes existing check marks. |
| `steward_search` | Searches every `AGENTS.md`, the plugin registry and `PLAN-*.md` for the literal text and returns `path:line`, so "did I say this before?" does not rely on memory. |
| `steward_ledger` | Lists every rule registered in the ledger and marks whether it can still be found in its file (missing = hand-edited or deleted). |
| `steward_timeline` | Threads ledger changes, error records, plans and rules by date into a timeline; can write `TIMELINE.md` into a workspace. |

## Two mechanisms that do not rely on the model's goodwill

- **System prompt section "Rule discipline"**: always present, requires a card before any action.
- **`agent/pre-step` reminder**: when a message sounds like a standing rule ("remember / from now on / always"), one reminder is appended to force `steward_card`. Set `KOUJING_NO_REMIND=1` to disable.
- **Language**: both injected texts follow the system language (`zh*` → Chinese, otherwise English). Force it with the `policyLanguage: auto|zh|en` config or the `KOUJING_POLICY_LANG` environment variable.

## Where the data lives

| Item | Path |
|---|---|
| Rule text | `~/.dsh/AGENTS.md` (user level) or `<workspace>/AGENTS.md` (workspace level) |
| Ledger index | `~/.dsh/steward/ledger.json` (source, target and time only) |
| Backups before writing | `~/.dsh/steward/backups/` |
| Placement routes (optional) | `~/.dsh/steward/domains.json` |
| Plans / timeline | `<workspace>/PLAN-*.md`, `<workspace>/TIMELINE.md` |

The plugin ships no database of its own.

## Three update modes of `save`

| mode | Sections not passed | Sections passed | `steps` | Hand-written sections |
|---|---|---|---|---|
| `merge` (default) | kept as-is | replaced wholesale | merged by exact text: matched ones only get their wording updated, unpassed old steps and `[x]` stay, new ones appended | kept |
| `append` | kept as-is | appended to the end of the section (skipped if identical) | appended only | kept |
| `replace` | mandatory sections become "（待补）" | replaced wholesale | taken as passed | dropped and reported |

Three invariants:

- **The progress log is never cleared by `save`** (only `update` appends to it).
- Check marks follow the file: passing step text alone never unticks anything.
- `title` decides the filename; renaming the title saves a new file and never renames the old one.

## How it differs from lookalikes

| Common assumption | Reality |
|---|---|
| "Another memory plugin" | No automatic recall, no embeddings, no codebase scanning. It only reads and writes the `AGENTS.md` and `PLAN-*.md` you authored. |
| "Another session manager" | No grouping, no archiving, no touching the session list. |
| "Another task system" | It does not replace the host's todo / goal. It manages long-lived cross-session conventions and plan files you can hand to a person. |
| "Just put rules in the system prompt" | The output is plain markdown: diffable, reviewable, portable, readable by other tools. That is the one real selling point. |

## FAQ

1. **Can it damage my rules?** It backs up to `~/.dsh/steward/backups/` before writing, appends instead of rewriting, and asks before writing when a similar entry already exists.
2. **How does it pick a workspace?** By "would this still hold in another workspace?" (a named workspace wins, otherwise user level); force it with the `workspace` parameter.
3. **Do I have to rewrite a whole plan to change one line?** No: `merge` (default) only merges the changed steps and keeps check marks and hand-written sections.
4. **Panel blank or 401?** Both data routes are same-origin read-only endpoints that need a token-bearing page; opening the URL directly returns 401 by design.
5. **Can I turn off the automatic reminder?** `KOUJING_NO_REMIND=1`.
6. **Does it work outside Windows?** Pure Node, no native dependency, no external programs. The `docs-lint` gate is optional and skipped when absent.
7. **What is left after uninstalling?** The ledger and backups under `~/.dsh/koujing` (delete them to clean up); the rules in `AGENTS.md` are your own text and are never removed.

## Limits

- "Does this sound like a rule" is a heuristic (keywords + similarity); pass `kind` explicitly when it guesses wrong.
- **The target section is a heuristic too**: a short sentence may land in a section that looks close word-wise but is not semantically close. Check the section before writing, or pass `section` explicitly.
- **Duplicate detection only compares inside one file** (with a high similarity threshold): an equivalent rule in another file or workspace is not flagged automatically. When you suspect one exists, check by hand to avoid a second copy.
- It only writes rules; project plans always go through `steward_plan`.
- The two read-only routes accept no writes: the panel cannot edit rules — use `steward_commit`, which backs up and records.

## Tests

```bash
node dev/smoke.mjs    # core logic against a temporary HOME
node dev/routes.mjs   # 200 / 401 / allow for both read-only routes
```

## License

MIT
