# scopeburn

**Roadmap burn-up meets Claude Code spend.** For solo developers who build with Claude Code.

Plenty of tools count your tokens. scopeburn ties them to your progress. For each project it answers:

- Is the scope growing faster than I finish things?
- Which items did I decide on and never start?
- What did each roadmap item cost in Claude usage?
- What will it take to finish what's left, in dollars and in 5-hour windows?

Everything runs locally. scopeburn reads Claude Code's own logs (`~/.claude/projects`) and your `ROADMAP.md` files.
It makes **no network requests** and sends no telemetry.

## Quick start

```bash
npx scopeburn usage              # spend per project, last 30 days
npx scopeburn init               # write a ROADMAP.md template in this repo
npx scopeburn roadmap            # burn-up, waiting items, cost per item, cost to finish
npx scopeburn report --open      # interactive dashboard (one HTML file)
```

In Claude Code: `npx scopeburn skill install`, then ask *"how are my projects going?"* or run `/scopeburn`.
The skill also keeps `ROADMAP.md` current as you work.

## ROADMAP.md

```markdown
# ROADMAP · my-app
stage: beta

## v1
- [x] {auth} Sign-in ~M @decided(2026-09-01) @done(2026-09-03)
- [ ] {sync} Offline sync ~L @decided(2026-09-02) @start(2026-09-05)
  - [x] {sync.pull} Pull ~M
  - [ ] {sync.push} Push
- [ ] {share} Share links ~S @decided(2026-09-04) @start(2026-09-06) @paused(2026-09-08)
- [-] {themes} Custom themes ~L @cut(2026-09-07) — not for v1
```

- `- [ ]` open, `- [x]` done, `- [-]` cut. Only leaf items count.
- `{ID}` is the key for history and cost tracking. Never rename it. Items without one still work, tracked by title.
- Sizes are points: `~S` 1, `~M` 2 (the default), `~L` 4, `~XL` 8.
- Dates are optional. When present they rebuild your past burn-up, so the chart works on day one. When absent they are filled in from the file's git history.
- `@paused` stops an item from absorbing cost while you wait on something.
- Put `{ID}` in a commit message to attribute that commit's Claude usage exactly.

## Commands

| Command | What it does |
|---|---|
| `usage` | Tokens and API-equivalent cost by project, day or model. Matches ccusage for the same sessions. |
| `roadmap [repo…]` | Scope vs done, the 14-day growth ratio, waiting and in-progress items, spend per item, cost to finish |
| `limits` | 5-hour and weekly windows: spend, burn rate, estimated cap and when you'll hit it |
| `report` / `serve` | Interactive dashboard as a single HTML file, or live on `127.0.0.1` |
| `init` | `ROADMAP.md` template |
| `calibrate <5h%> [week%]` | Record what `/usage` shows, to estimate your plan's cap |
| `statusline install` | Record `/usage` numbers automatically (terminal Claude Code, Pro/Max). Wraps any status line you already have. |
| `config` | Billing (`subscription` or `api`), plan, monthly fee, display currency |
| `doctor` | Parser and attribution diagnostics, safe to paste into an issue |

## How it attributes usage

1. **To projects.** Each response goes to the git repository whose files its tools touched. Responses with no file paths inherit from their turn, then their session.
   Inside a folder that holds several repos, non-git subfolders count as projects too.
2. **To roadmap items.** A commit tagged with `{ID}` claims the usage since the previous commit. Otherwise usage at time *t* goes to the items in progress at *t*, weighted by size. The rest is reported as *outside the roadmap*.
3. **To dollars.** Official API prices (`data/prices.json`, with the date checked). On a subscription this is an *API-equivalent* figure, not your bill.

Subscription caps aren't published as token counts. scopeburn estimates your cap by pairing the `/usage` percentage with your local API-equivalent spend in the same window.
Usage from the web app or other machines makes the estimate run low, and the spread between samples shows that.

## Privacy

- Reads only usage numbers, ids, timestamps and path-like tool inputs from the logs. Conversation text is never stored.
- The dashboard holds numbers, project names and roadmap item titles. `--redact` replaces names and titles before you share it.

## License

MIT
