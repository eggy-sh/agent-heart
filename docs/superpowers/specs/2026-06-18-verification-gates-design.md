# Verification Gates — Design

**Date:** 2026-06-18
**Status:** Approved for implementation
**Maps to:** "Use tools for oversight" — treat an agent's output as something to verify *after* it has self-reviewed or passed automated tests. A run finishing is not the same as a run being trusted.

## Problem

Today a run ends `completed` or `failed`, and `completed` reads as "done, trust it." But in an autonomous loop the agent marks its own work complete. The buyer needs a distinction between "the agent finished" and "the work was verified," plus a way to see which completed runs still need oversight.

## Goals

1. A run can be marked **completed-but-unverified** at unlock (`--needs-verify`).
2. A **`verify`** step promotes it to `passed` (or records `failed`).
3. `status` surfaces how many completed runs are **awaiting verification**, and `runs --unverified` lists them.
4. Backward compatible: runs that don't opt in have `verification = null` and behave exactly as before.

## Non-Goals (YAGNI)

- No automatic verification (running tests for you) — `verify` records a verdict the caller already has.
- No blocking of downstream work — verification is an annotation; enforcement (if any) is the caller's via `runs --unverified --json` / exit semantics.
- No re-verification history — a single current `verification` state per run.

## Design

### 1. Data model (`src/core/models.ts`)

- `VerificationStatus = "pending" | "passed" | "failed"` (const + type, like `RunStatus`).
- `Run`: add `verification: VerificationStatus | null`.
- `HeartbeatRequestSchema`: add `requires_verification: z.boolean().optional()` (consumed on `unlock`).
- New `VerifyRequestSchema` (`status: "passed" | "failed"`, `message?`) and `VerificationSummary` type.

### 2. Persistence (`src/server/db.ts`)

- Add `verification TEXT` to `runs`; idempotent `ensureColumn` migration.
- `createRun` stores null; `rowToRun` maps it; `updateRun` already generic.
- `verifyRun(runId, status, message?)`: sets `verification` and appends/sets message; throws if the run is missing.
- `countUnverified()` / extend `listRuns` with a `verification` filter for `runs --unverified`.

### 3. API + SDK

- `unlock` path in `/heartbeat`: when `requires_verification` is true, set `verification = "pending"` alongside the normal completion update.
- `POST /api/v1/runs/:id/verify` → `{ status, message? }`, returns the updated run (404 if missing).
- `PulseClient.verify(runId, { status, message })`.

### 4. Core helper (`src/core/verification.ts`, pure + unit-tested)

- `summarizeVerification(runs): { pending: number; passed: number; failed: number }` — drives the status line and is independently testable.

### 5. CLI

- `unlock`: add `--needs-verify` (sets `requires_verification: true`).
- New `verify` command: `agent-heart verify --run-id <id> [--pass | --fail] [--message <m>]` (default `--pass`); `--json` prints the updated run.
- `status`: a line — `N run(s) completed but awaiting verification` (warning-colored) when `pending > 0`, and a failed-verification callout.
- `runs --unverified`: filter to `verification = "pending"`.

## Error handling

- `verify` on a missing run → 404 / clear CLI error, exit 1.
- `--pass` and `--fail` both given → usage error (mutually exclusive).
- Old DB without the column → `ensureColumn` migration on server start.

## Testing

1. **`verification.test.ts`** (pure): `summarizeVerification` counts pending/passed/failed and ignores `null`.
2. **`db.test.ts`**: `verification` defaults null and round-trips; `verifyRun` sets passed/failed; `listRuns({ verification: "pending" })` filters; migration adds the column to a legacy DB.
3. **`models.test.ts`**: `HeartbeatRequestSchema` accepts `requires_verification`; `VerifyRequestSchema` accepts/rejects.

`npm run build` + `npx tsc --noEmit` pass. Live smoke: `unlock --needs-verify` → pending; `verify --pass` → passed; `status` shows the awaiting-verification line; `runs --unverified` lists only pending.

## Docs

- README: "Verification Gates" section (the agent finishing ≠ verified).
- `docs/scenarios.md`: a loop that gates trust on verification.
- `docs/roadmap.md`: note under Agent Metadata.

## Rollout / compatibility

Purely additive — new optional field, flag, command, and endpoint. Old clients, old databases, and existing flat workflows are unaffected.
