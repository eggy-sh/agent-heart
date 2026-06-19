# Watch / Notify — Design

**Date:** 2026-06-18
**Status:** Approved for implementation
**Maps to:** The "Heartbeat pattern" — orchestrate long-running background work while away from the keyboard. Instead of busy-polling `status` in a `/loop`, block on a single command that returns the moment the work resolves, with an exit code a loop can branch on.

## Problem

Today you watch agent work by repeatedly running `status`/`runs` and reading the output. For "walk away and tell me when it's done (or stuck)," there's no primitive that *blocks until* a run/session reaches a terminal or problem state and then signals the outcome. An orchestrating loop has to poll and parse.

## Goals

1. `agent-heart watch` blocks until the watched scope **resolves**, then exits with a meaningful code:
   - `0` — the relevant runs all completed successfully.
   - `1` — resolved, but something ended unsuccessfully (failed / dead / a `--until` problem state).
   - `124` — timed out (matches `timeout(1)`).
2. Scope by `--run-id`, `--session`, or `--service`.
3. `--until <states>` returns as soon as any watched run enters one of those states (e.g. `--until dead` as a death alarm); default waits for all watched runs to be terminal.
4. Optional `--webhook <url>` POSTs a JSON summary on resolve — the "notify" half of walk-away.
5. Self-contained and harness-agnostic: a client-side poll over the existing API. No DB/model/server changes.

## Non-Goals (YAGNI)

- No server-side long-poll/streaming (client poll is simple and sufficient at this scale).
- No desktop notifications / Slack adapters in v1 (a webhook covers integrations).
- No `--exec on-resolve` (the exit code already composes with the shell: `watch ... && next`).

## Design

### 1. Decision core (`src/core/watch.ts`, pure + unit-tested)

The only non-trivial logic, isolated so it's testable without a server or timers.

- Terminal states: `completed`, `failed`, `dead`.
- `interface WatchVerdict { resolved: boolean; exitCode: number; reason: string; counts: Record<string, number> }`
- `evaluateWatch(runs: Run[], until: RunStatus[] | null): WatchVerdict`
  - **Empty set** → `{ resolved: true, exitCode: 0, reason: "no matching runs" }` (nothing to wait on).
  - **`until` given** → `relevant = runs.filter(r => until.includes(r.status))`; resolved iff `relevant.length > 0`; `exitCode = relevant.every(completed) ? 0 : 1`.
  - **No `until`** → resolved iff every run is terminal; `exitCode = runs.every(completed) ? 0 : 1`.
  - `counts` summarizes statuses for display.

### 2. `watch` command (`src/cli/commands/watch.ts`)

- Options: `--service`, `--session`, `--run-id` (≥1 required), `--until <states>` (comma list), `--timeout <s>` (default 0 = no timeout), `--interval <s>` (default 2), `--webhook <url>`.
- Loop: fetch the watched runs (`getRun` for `--run-id`; otherwise `listRuns` by `--session`/`--service`, all statuses, high limit — **re-fetched each tick** so runs an orchestrator spawns mid-watch are included), call `evaluateWatch`, and on `resolved` print a summary, fire the webhook (best-effort), and `process.exit(exitCode)`. Otherwise sleep `interval` and repeat; on timeout print and `exit(124)`.
- Numeric options use the strict parser (a typo errors instead of becoming `NaN`).
- `--json` prints the final verdict + run summaries instead of the pretty summary.

### 3. SDK

- No new client method required (reuses `getRun`/`listRuns`). `evaluateWatch` is exported from the package root so SDK users can build their own waiters.

## Error handling

- No scope selector → clear usage error, exit 2.
- Server unreachable mid-watch → a tick's fetch error is non-fatal (logged in verbose) and retried next interval, so a server blip doesn't abort a long watch; persistent failure ends at timeout.
- Webhook failure → best-effort, never changes the exit code.
- `--until` with an unknown status name → usage error listing valid states.

## Testing

1. **`watch.test.ts`** (pure): empty set → resolved/0; all-completed → resolved/0; one failed → resolved/1; still-active (no until) → unresolved; `--until dead` with a dead run → resolved/1; `--until completed` with a completed + active → resolved/0; `--until stale` with none stale → unresolved; counts correctness.
2. `npm run build` + `npx tsc --noEmit` pass.
3. Live smoke: watch a session, transition its runs in the background, confirm `watch` blocks then returns with the right exit code; confirm `--until dead`, timeout → 124, and a webhook POST is received.

## Docs

- README: "Watch — Walk Away" section (block-until-resolved, exit codes, `--until`, webhook).
- `docs/scenarios.md`: a background refactor watched to completion while away.
- `docs/roadmap.md`: note watch under Operational Views.

## Rollout / compatibility

Purely additive — one new read-only command and one pure module. Nothing else changes.
