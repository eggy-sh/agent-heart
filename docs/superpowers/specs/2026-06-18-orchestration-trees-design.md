# Orchestration Trees — Design

**Date:** 2026-06-18
**Status:** Approved for implementation
**Maps to:** The "dynamic sub-threads" theme — agents that dynamically spin up sub-tasks to tackle multi-stage problems, rather than following rigid predefined workflows.

## Problem

Today every `Run` in agent-heart is flat. A `session_id` loosely groups runs, but there is no parent/child relationship. When an orchestrating agent spawns sub-tasks (the exact pattern the autonomous-loop workflow depends on), you cannot see *which run spawned which*, and you cannot tell at a glance whether an orchestrator's subtree is healthy.

A buyer evaluating agent-heart for autonomous-loop work needs to answer: "My orchestrator kicked off five sub-agents — is the whole tree fine, or is one branch stuck?"

## Goals

1. A run can record a `parent_run_id`, forming a tree.
2. **Zero-wiring auto-parenting** that works with *any* harness: when work runs under `agent-heart exec`, nested `agent-heart` calls automatically become children. No Claude-Code-specific hooks required.
3. `status --tree` and `runs --tree` render the hierarchy with **subtree health rollup** — a parent surfaces the worst state among its descendants.
4. Backward compatible: existing databases and existing flat workflows keep working unchanged.

## Non-Goals (YAGNI)

- No cross-service parent validation / referential integrity enforcement (orphans render as roots).
- No re-parenting after lock (parent is set once, at `lock`).
- No depth limit / cycle protection beyond a simple visited-set guard in the renderer.
- No new persisted "subtree severity" column — rollup is computed at read time.

## Design

### 1. Data model (`src/core/models.ts`)

- Add `parent_run_id: string | null` to the `Run` interface.
- Add `parent_run_id: z.string().optional()` to `HeartbeatRequestSchema`.

Only `lock` (createRun) consumes `parent_run_id`; `beat`/`unlock` ignore it.

### 2. Persistence (`src/server/db.ts`)

- Add `parent_run_id TEXT` to the `runs` `CREATE TABLE`.
- **Migration for existing DBs:** after table creation, run an idempotent `ensureColumn(db, "runs", "parent_run_id", "TEXT")` helper that checks `PRAGMA table_info(runs)` and `ALTER TABLE ... ADD COLUMN` only if missing. (`CREATE TABLE IF NOT EXISTS` does not add columns to an existing table.)
- Add index `idx_runs_parent_run_id`.
- `createRun` stores `req.parent_run_id ?? null`; `rowToRun` maps it.
- Add `getRunTree(rootId): Run[]` using a recursive CTE that returns the root plus all descendants (parents-before-children order). Used by the API endpoint.

### 3. Auto-parenting via environment variable (harness-agnostic core)

A single well-known env var carries parentage across process boundaries — the mechanism every shell/agent already propagates to child processes:

```
AGENT_HEART_RUN_ID
```

- **Resolution order for a new run's parent:** explicit `--parent <id>` flag → `AGENT_HEART_RUN_ID` env → none.
- **`exec`** sets `AGENT_HEART_RUN_ID=<its own run_id>` in the spawned child's environment. Any nested `agent-heart` invocation inside that child therefore auto-attaches as a child of this run. Grandchildren chain correctly because each `exec` overwrites the var with *its own* run id for *its* subtree.
- **`lock`** reads the same flag/env, so manual multi-step workflows can opt in by exporting the var (or passing `--parent`).

Result: an orchestrator wrapping its work in `exec` gets a full tree with no manual run-id threading — on Claude Code, a bare shell, CI, or any other harness.

### 4. Tree building + rollup (`src/core/tree.ts`, pure + unit-tested)

A dependency-free module so the core logic is testable without a server:

- `Severity` ordering: `ok < warning < critical`. Statuses map to severity for rollup: `dead`→critical, `stale`→warning, `failed`→ (critical if non-zero exit) else ok, others→ok. (Reuse each run's stored `severity`; fall back to status-derived.)
- `interface RunTreeNode { run: Run; children: RunTreeNode[]; subtreeSeverity: Severity; descendantCount: number; }`
- `buildRunForest(runs: Run[]): RunTreeNode[]` — groups by `parent_run_id`; a run whose parent is absent from the set becomes a root (orphan-safe). Children sorted by `started_at`. Computes `subtreeSeverity = max(self, children…)` bottom-up. Cycle-guarded by a visited set.

### 5. Rendering (`status --tree`, `runs --tree`)

- Add `--tree` flag to `status` and `runs`.
- Fetch the relevant runs (existing `listRuns`, larger limit; for `status` the active/locked/stale set), build the forest, and render an indented tree (`├─`, `└─`) showing per-node: short run id, service, tool, own status, duration.
- A parent whose `subtreeSeverity` is worse than its own status is annotated (e.g. `⚠ subtree`) so a stuck leaf is visible from the root.
- `--json` returns the nested forest structure.

### 6. API + SDK

- `GET /api/v1/runs/:id/tree` → `{ runs: Run[] }` (root + descendants via `getRunTree`). Lets a remote orchestrator pull a subtree directly.
- `PulseClient.getRunTree(runId)` mirrors it.

## Error handling

- Unknown/absent parent: stored as-is; renders as a root. No error.
- Missing column on an old DB: handled by the idempotent migration on server start.
- `runs/:id/tree` on a missing root: `404`, consistent with `runs/:id`.

## Testing

First test suite in the repo (`vitest` already a devDep). All runnable without a live HTTP server:

1. **`tree.test.ts`** (pure): forest construction, nesting, orphan-as-root, `started_at` ordering, subtree severity rollup (deep stale leaf bubbles a warning to root; dead bubbles critical), cycle guard.
2. **`db.test.ts`** (temp sqlite file via `createDatabase`): `parent_run_id` round-trips through `createRun`/`getRun`/`listRuns`; `getRunTree` returns root + nested descendants; migration adds the column to a DB created without it.
3. **`models.test.ts`**: `HeartbeatRequestSchema` accepts and round-trips `parent_run_id`.

`npm run build` (tsup) and `npm run lint` (tsc) must pass.

## Docs

- README: new "Orchestration Trees" subsection with the auto-parenting example and `status --tree` output; note it is harness-agnostic.
- `docs/scenarios.md`: an orchestrator-with-sub-agents walkthrough.
- `docs/roadmap.md`: mark sub-run trees under operational views.

## Rollout / compatibility

Purely additive. New optional field, new optional flags, new endpoint. Old clients, old databases, and flat workflows are unaffected.
