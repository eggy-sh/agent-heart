# Cost & Token Budgets — Design

**Date:** 2026-06-18
**Status:** Approved for implementation
**Maps to:** "Monitor Costs and Limits" — autonomous loops burn tokens far faster than hand-prompting, so a buyer needs to see spend and cap it before a runaway loop drains a budget.

## Problem

agent-heart tracks duration but has no notion of token or dollar cost. For someone running self-prompting loops, the first question after "is it stuck?" is "what is this costing me, and how do I stop it before it blows the budget?" Today there is no answer.

## Goals

1. Record **tokens** and **cost (USD)** per run, reported by the agent as it works.
2. Aggregate spend per **session** and per **service**.
3. Define **budgets** per service and evaluate spend against them (ok / warning / over).
4. A **`spend`** command surfaces it, and `spend --fail-over-budget` exits non-zero so an agent loop can **self-halt** when it crosses a limit — enforcement the loop drives itself, matching the "designing loops" philosophy.
5. Backward compatible and harness-agnostic (CLI flags + SDK; any agent can report).

## Non-Goals (YAGNI)

- No per-model price tables / automatic cost computation — the caller reports the numbers it already has.
- No hard kill of a running process from the server (the loop self-halts via the exit code).
- No budgets at the per-run or per-session level in v1 (service-level budgets only; sessions/services still get spend totals).

## Design

### 1. Data model (`src/core/models.ts`)

- `Run`: add `tokens: number | null`, `cost_usd: number | null`.
- `HeartbeatRequestSchema`: add `tokens: z.number().int().nonnegative().optional()`, `cost_usd: z.number().nonnegative().optional()`.
- `ServiceConfig`: add `budget_tokens?: number`, `budget_usd?: number`.
- New `SpendResponse` and `SpendScope` types.

**Set semantics:** tokens/cost are the agent's cumulative total for that run; the latest reported value wins (a later `beat`/`unlock` overwrites). Aggregation then sums across runs.

### 2. Persistence (`src/server/db.ts`)

- Add `tokens INTEGER`, `cost_usd REAL` to `runs`; `budget_tokens INTEGER`, `budget_usd REAL` to `services`. Idempotent `ensureColumn` migrations for both tables.
- `createRun` stores tokens/cost (usually null at lock); `rowToRun` maps them; `rowToServiceConfig`/`upsertService` handle budgets.
- `getSpend(filters?: { service?; session? })`: returns `{ services: Array<{service_name, tokens, cost_usd, runs}>, sessions: Array<{session_id, tokens, cost_usd, runs}>, total }` via `SUM`/`COUNT` grouped queries (COALESCE nulls to 0).

### 3. Budget evaluation (`src/core/budget.ts`, pure + unit-tested)

- `evaluateBudget(used: {tokens, cost_usd}, limit: {tokens?, cost_usd?}): BudgetEval` where `BudgetEval = { tokens: Metric, cost_usd: Metric, severity: Severity }` and `Metric = { used, limit: number|null, pct: number|null, severity }`.
- Per metric: no limit → `ok`, pct ≥ 100 → `critical`, pct ≥ 80 → `warning`, else `ok`. Overall severity = worst of the two.
- `isOverBudget(eval): boolean` → severity === critical.

### 4. API + SDK

- `GET /api/v1/spend?service=&session=` → `SpendResponse` (server attaches each service's budget + `evaluateBudget` result).
- `PulseClient.spend(params)`; `beat`/`unlock`/`lock` already accept `Partial<HeartbeatRequest>`, so `tokens`/`cost_usd` flow through once the schema has them.

### 5. CLI

- `beat`, `unlock`, `lock`: add `--tokens <n>` and `--cost <usd>` (parseFloat), passed through.
- New `spend` command: `agent-heart spend [--service X] [--session Y] [--fail-over-budget]`.
  - Pretty: per-service table with `used / budget` and a `████░░ 82%` bar coloured by severity; top sessions by cost; a `⚠ over budget` line per breached service.
  - `--json`: the `SpendResponse`.
  - `--fail-over-budget`: `process.exit(1)` if any shown service is over budget — the loop's stop signal.

### 6. Error handling

- Missing columns on an old DB: handled by `ensureColumn` on server start.
- Negative tokens/cost rejected by the schema (`nonnegative`).
- `spend` with no runs: zeros, exit 0.

## Testing

1. **`budget.test.ts`** (pure): no-limit→ok; 50%→ok; 80%→warning; 100%/over→critical; worst-of-two; `isOverBudget`.
2. **`db.test.ts`** additions: tokens/cost round-trip and overwrite-latest; `getSpend` sums across runs and groups by service/session; service budget columns persist; migration adds all four columns to a legacy DB.
3. **`models.test.ts`** additions: schema accepts tokens/cost; rejects negatives.

`npm run build` and `npx tsc --noEmit` must pass. Plus a live smoke test: report tokens/cost via `beat`, set a service budget, and confirm `spend` shows the bar and `--fail-over-budget` exits 1 when over.

## Docs

- README: "Cost & Token Budgets" section (report spend, set budgets, `spend --fail-over-budget` in a loop).
- `docs/scenarios.md`: a loop that self-halts on budget.
- `docs/roadmap.md`: note budgets under Agent Metadata.

## Rollout / compatibility

Purely additive — new optional fields, flags, command, and endpoint. Old clients, old databases, and flat workflows are unaffected.
