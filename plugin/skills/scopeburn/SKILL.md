---
name: scopeburn
description: Solo-dev progress and Claude spend. Use when the user asks how a project is going, what's left, what it cost, or how much of the 5-hour/weekly limit is used. Also use when starting, finishing, deciding, pausing or dropping a roadmap item in a repo that has a ROADMAP.md, and when asked to set up a ROADMAP.md (`/scopeburn init`).
---

# scopeburn

scopeburn reads Claude Code's local usage logs and each project's `ROADMAP.md`. From them it shows:
- scope vs done (burn-up)
- items that were decided but never started
- Claude spend per project and per roadmap item
- the cost of finishing what's left
- subscription 5-hour and weekly window usage

Run it with: `npx -y scopeburn@latest`

## Commands

| User asks | Run |
|---|---|
| status / how are my projects going / `/scopeburn` | `npx -y scopeburn@latest roadmap`, then `npx -y scopeburn@latest limits` |
| one project | `npx -y scopeburn@latest roadmap <repo path>` (`--items` lists every item's spend) |
| what did I spend | `npx -y scopeburn@latest usage` (`--by day`, `--by model`, `--days N`, `--since YYYY-MM-DD`) |
| limits / will I hit the cap | `npx -y scopeburn@latest limits` |
| the dashboard | `npx -y scopeburn@latest report --open`, or `npx -y scopeburn@latest serve --open` for a live one |
| record the `/usage` numbers | `npx -y scopeburn@latest calibrate <5h%> [weekly%]` |
| set billing | `npx -y scopeburn@latest config --billing subscription --plan max5 --fee 100` (or `--billing api`; `--currency KRW --rate 1400` for local currency) |

After running, give 3 to 5 lines of interpretation, not the raw output. Lead with what needs a decision:
- `growth` above 1: scope is growing faster than work gets done. Ask whether to cut something.
- items waiting 14+ days since they were decided
- a project idle for 7+ days with items in progress
- a projected cap hit before the window resets

All money figures are API-equivalent estimates. Say "about".

## Keeping ROADMAP.md current

When the repo you're working in has a `ROADMAP.md`, keep it current as part of the work. Do it in the same commit as the work; never in a separate commit.

- **Starting an item**: add `@start(YYYY-MM-DD)`.
- **Finishing it**: change `- [ ]` to `- [x]` and add `@done(YYYY-MM-DD)`.
- **The user decides to do something new**: add an item with a new unique `{ID}`, a size (`~S` ~1h–half day, `~M` about a day, `~L` a few days, `~XL` a week or more) and `@decided(YYYY-MM-DD)`.
- **The user drops something**: `- [-]`, `@cut(YYYY-MM-DD)`, and a short reason after ` — `.
- **Blocked on someone else** (a review, an answer): `@paused(YYYY-MM-DD)`. Remove it with a fresh `@start` when work resumes.
- Never rename or reuse an `{ID}`. History and cost tracking key on it.
- Put the item's `{ID}` in the commit message when a commit is mainly about one item. This makes the cost attribution exact. It's optional.
- Use today's date in the user's local time zone.

## `/scopeburn init`: writing a first ROADMAP.md

1. Run `npx -y scopeburn@latest init <repo>`. It writes a template, and never overwrites an existing file.
2. Fill it from what the repo already says. Use the status or plan docs (for example `docs/*`, `TODO*`, `CHANGELOG*`) and `git log --since=90.days --format="%cs %s"`.
   - Group items by milestone.
   - Use real dates from git for `@decided`/`@done`. They rebuild the burn-up history, so with good dates the chart starts on day one.
   - Keep each item one line, in the user's language.
3. Show the user the draft and ask what's wrong: sizes, missing items, things already dropped. Don't commit until they say so.
4. Run `npx -y scopeburn@latest roadmap <repo>` and show the result.

## Notes
- Nothing leaves the machine. scopeburn makes no network requests.
- Sessions that ran elsewhere and were copied into this machine's logs are counted by default. `--local-only` excludes them.
- The status line hook (`npx -y scopeburn@latest statusline install`) records `/usage` percentages automatically in terminal Claude Code. IDE extensions may not run status line commands; use `calibrate` there.
