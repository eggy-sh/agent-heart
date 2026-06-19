import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { createDatabase, type PulseDB } from "./db.js";
import type { HeartbeatRequest, Run } from "../core/models.js";

const tempFiles: string[] = [];
function tempDbPath(): string {
  const p = join(
    tmpdir(),
    `agent-heart-core-${process.pid}-${tempFiles.length}-${Math.floor(performance.now() * 1000)}.db`,
  );
  tempFiles.push(p);
  return p;
}
function lockReq(overrides: Partial<HeartbeatRequest> = {}): HeartbeatRequest {
  return { service_name: "svc", action: "lock", ...overrides };
}
const agoIso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

/** Create a run and force it into a terminal state with a controlled started_at. */
function settledRun(
  db: PulseDB,
  opts: { service?: string; status: "completed" | "failed"; exit: number; startedAgoMs: number },
): Run {
  const run = db.createRun(lockReq({ service_name: opts.service ?? "svc" }));
  return db.updateRun(run.run_id, {
    status: opts.status,
    exit_code: opts.exit,
    started_at: agoIso(opts.startedAgoMs),
  });
}

afterEach(() => {
  while (tempFiles.length) {
    const p = tempFiles.pop()!;
    if (existsSync(p)) rmSync(p, { force: true });
  }
});

describe("stale detection (getStaleRuns / markStale)", () => {
  it("does not flag a freshly-beating run", async () => {
    const db = await createDatabase(tempDbPath());
    db.createRun(lockReq());
    expect(db.getStaleRuns(1000)).toHaveLength(0);
    db.close();
  });

  it("flags a run whose last heartbeat exceeds the expected cycle", async () => {
    const db = await createDatabase(tempDbPath());
    const run = db.createRun(lockReq());
    db.updateRun(run.run_id, { last_heartbeat: agoIso(5000) });

    const stale = db.getStaleRuns(1000);
    expect(stale.map((r) => r.run_id)).toContain(run.run_id);

    db.markStale(run.run_id);
    const after = db.getRun(run.run_id)!;
    expect(after.status).toBe("stale");
    expect(after.severity).toBe("warning");
    db.close();
  });

  it("honors a per-service expected_cycle_ms over the default", async () => {
    const db = await createDatabase(tempDbPath());
    db.upsertService({ name: "slow", expected_cycle_ms: 100_000, max_silence_ms: 200_000 });
    const run = db.createRun(lockReq({ service_name: "slow" }));
    db.updateRun(run.run_id, { last_heartbeat: agoIso(5000) });
    // 5s old, but "slow" tolerates 100s, so the default 1s threshold must not apply.
    expect(db.getStaleRuns(1000).map((r) => r.run_id)).not.toContain(run.run_id);
    db.close();
  });
});

describe("dead detection (getDeadRuns / markDead)", () => {
  it("flags a run silent past max_silence and marks it dead", async () => {
    const db = await createDatabase(tempDbPath());
    const run = db.createRun(lockReq());
    db.updateRun(run.run_id, { last_heartbeat: agoIso(10_000) });

    expect(db.getDeadRuns(5000).map((r) => r.run_id)).toContain(run.run_id);
    db.markDead(run.run_id);
    const after = db.getRun(run.run_id)!;
    expect(after.status).toBe("dead");
    expect(after.severity).toBe("critical");
    db.close();
  });

  it("also considers already-stale runs for death", async () => {
    const db = await createDatabase(tempDbPath());
    const run = db.createRun(lockReq());
    db.updateRun(run.run_id, { last_heartbeat: agoIso(10_000) });
    db.markStale(run.run_id);
    expect(db.getDeadRuns(5000).map((r) => r.run_id)).toContain(run.run_id);
    db.close();
  });
});

describe("countRuns / getActiveRuns", () => {
  it("counts runs by status bucket", async () => {
    const db = await createDatabase(tempDbPath());
    db.createRun(lockReq()); // locked -> active bucket
    const a = db.createRun(lockReq());
    db.updateRun(a.run_id, { status: "active" });
    settledRun(db, { status: "completed", exit: 0, startedAgoMs: 3000 });
    settledRun(db, { status: "failed", exit: 1, startedAgoMs: 2000 });
    const dead = db.createRun(lockReq());
    db.markDead(dead.run_id);

    const c = db.countRuns();
    expect(c.active).toBe(2); // locked + active
    expect(c.completed).toBe(1);
    expect(c.failed).toBe(1);
    expect(c.dead).toBe(1);

    expect(db.getActiveRuns()).toHaveLength(2);
    db.close();
  });
});

describe("getRecentRuns", () => {
  it("returns only terminal runs for the service, newest first, limited", async () => {
    const db = await createDatabase(tempDbPath());
    settledRun(db, { service: "svc", status: "completed", exit: 0, startedAgoMs: 3000 });
    settledRun(db, { service: "svc", status: "failed", exit: 1, startedAgoMs: 1000 });
    db.createRun(lockReq({ service_name: "svc" })); // locked -> excluded
    settledRun(db, { service: "other", status: "completed", exit: 0, startedAgoMs: 500 });

    const recent = db.getRecentRuns("svc", 10);
    expect(recent).toHaveLength(2);
    expect(recent.every((r) => r.service_name === "svc")).toBe(true);
    // newest (1s ago, failed) before older (3s ago, completed)
    expect(recent[0].status).toBe("failed");
    db.close();
  });
});

describe("getServiceStates — consecutive-failure (loop) detection", () => {
  it("counts a run of consecutive failures and escalates severity", async () => {
    const db = await createDatabase(tempDbPath());
    settledRun(db, { status: "failed", exit: 1, startedAgoMs: 3000 });
    settledRun(db, { status: "failed", exit: 1, startedAgoMs: 2000 });
    settledRun(db, { status: "failed", exit: 1, startedAgoMs: 1000 });

    const svc = db.getServiceStates().find((s) => s.service_name === "svc")!;
    expect(svc.consecutive_failures).toBe(3);
    expect(svc.severity).toBe("critical");
    db.close();
  });

  it("resets the streak when the most recent run succeeded", async () => {
    const db = await createDatabase(tempDbPath());
    settledRun(db, { status: "failed", exit: 1, startedAgoMs: 3000 });
    settledRun(db, { status: "failed", exit: 1, startedAgoMs: 2000 });
    settledRun(db, { status: "completed", exit: 0, startedAgoMs: 1000 }); // newest = success

    const svc = db.getServiceStates().find((s) => s.service_name === "svc")!;
    expect(svc.consecutive_failures).toBe(0);
    db.close();
  });

  it("reports a dead run as a critical service state", async () => {
    const db = await createDatabase(tempDbPath());
    const run = db.createRun(lockReq());
    db.markDead(run.run_id);
    const svc = db.getServiceStates().find((s) => s.service_name === "svc")!;
    expect(svc.status).toBe("dead");
    expect(svc.severity).toBe("critical");
    expect(svc.dead_runs).toBe(1);
    db.close();
  });
});
