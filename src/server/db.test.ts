import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import initSqlJs from "sql.js";
import { createDatabase, type PulseDB } from "./db.js";
import type { HeartbeatRequest } from "../core/models.js";

const tempFiles: string[] = [];

function tempDbPath(): string {
  const p = join(
    tmpdir(),
    `agent-heart-test-${process.pid}-${tempFiles.length}-${Math.floor(performance.now() * 1000)}.db`,
  );
  tempFiles.push(p);
  return p;
}

function lockReq(overrides: Partial<HeartbeatRequest> = {}): HeartbeatRequest {
  return { service_name: "svc", action: "lock", ...overrides };
}

afterEach(() => {
  while (tempFiles.length) {
    const p = tempFiles.pop()!;
    if (existsSync(p)) rmSync(p, { force: true });
  }
});

describe("PulseDB parent_run_id", () => {
  it("round-trips parent_run_id through createRun/getRun/listRuns", async () => {
    const db: PulseDB = await createDatabase(tempDbPath());
    const parent = db.createRun(lockReq());
    const child = db.createRun(lockReq({ parent_run_id: parent.run_id }));

    expect(child.parent_run_id).toBe(parent.run_id);
    expect(db.getRun(child.run_id)?.parent_run_id).toBe(parent.run_id);

    const listed = db.listRuns({ service: "svc" });
    const listedChild = listed.find((r) => r.run_id === child.run_id);
    expect(listedChild?.parent_run_id).toBe(parent.run_id);

    db.close();
  });

  it("defaults parent_run_id to null when absent", async () => {
    const db = await createDatabase(tempDbPath());
    const run = db.createRun(lockReq());
    expect(run.parent_run_id).toBeNull();
    expect(db.getRun(run.run_id)?.parent_run_id).toBeNull();
    db.close();
  });

  it("getRunTree returns the root and all descendants, root first", async () => {
    const db = await createDatabase(tempDbPath());
    const root = db.createRun(lockReq({ service_name: "orchestrator" }));
    const child = db.createRun(
      lockReq({ service_name: "sub", parent_run_id: root.run_id }),
    );
    const grandchild = db.createRun(
      lockReq({ service_name: "sub", parent_run_id: child.run_id }),
    );
    db.createRun(lockReq({ service_name: "other" }));

    const tree = db.getRunTree(root.run_id);
    const ids = tree.map((r) => r.run_id);

    expect(ids[0]).toBe(root.run_id);
    expect(new Set(ids)).toEqual(
      new Set([root.run_id, child.run_id, grandchild.run_id]),
    );
    db.close();
  });

  it("returns an empty tree for an unknown root", async () => {
    const db = await createDatabase(tempDbPath());
    expect(db.getRunTree("nope")).toEqual([]);
    db.close();
  });

  it("returns each run once even when the data contains a cycle", async () => {
    const db = await createDatabase(tempDbPath());
    const a = db.createRun(lockReq());
    const b = db.createRun(lockReq({ parent_run_id: a.run_id }));
    db.updateRun(a.run_id, { parent_run_id: b.run_id });

    const tree = db.getRunTree(a.run_id);
    const ids = tree.map((r) => r.run_id);
    expect(ids[0]).toBe(a.run_id);
    expect(new Set(ids)).toEqual(new Set([a.run_id, b.run_id]));
    expect(ids).toHaveLength(2);
    db.close();
  });

  it("migrates a pre-existing database that lacks the parent_run_id column", async () => {
    const path = tempDbPath();
    const SQL = await initSqlJs();
    const legacy = new SQL.Database();
    legacy.run(`
      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY, session_id TEXT, service_name TEXT NOT NULL,
        tool_name TEXT, command TEXT, command_family TEXT, resource_kind TEXT,
        resource_id TEXT, status TEXT NOT NULL DEFAULT 'locked',
        severity TEXT NOT NULL DEFAULT 'ok', message TEXT, exit_code INTEGER,
        duration_ms INTEGER, started_at TEXT NOT NULL, last_heartbeat TEXT NOT NULL,
        completed_at TEXT, metadata TEXT NOT NULL DEFAULT '{}'
      );
    `);
    legacy.run(
      `INSERT INTO runs (run_id, service_name, status, severity, started_at, last_heartbeat, metadata)
       VALUES ('legacy1', 'svc', 'completed', 'ok', '2026-06-18T00:00:00.000Z', '2026-06-18T00:00:00.000Z', '{}')`,
    );
    writeFileSync(path, Buffer.from(legacy.export()));
    legacy.close();

    const db = await createDatabase(path);
    expect(db.getRun("legacy1")?.parent_run_id).toBeNull();
    const child = db.createRun(lockReq({ parent_run_id: "legacy1" }));
    expect(db.getRun(child.run_id)?.parent_run_id).toBe("legacy1");
    db.close();
  });
});

describe("PulseDB tokens & cost", () => {
  it("round-trips tokens and cost_usd, defaulting to null", async () => {
    const db = await createDatabase(tempDbPath());
    const withCost = db.createRun(lockReq({ tokens: 1200, cost_usd: 0.42 }));
    expect(withCost.tokens).toBe(1200);
    expect(withCost.cost_usd).toBeCloseTo(0.42);
    expect(db.getRun(withCost.run_id)?.tokens).toBe(1200);

    const without = db.createRun(lockReq());
    expect(without.tokens).toBeNull();
    expect(without.cost_usd).toBeNull();
    db.close();
  });

  it("lets a later update overwrite the cumulative tokens/cost", async () => {
    const db = await createDatabase(tempDbPath());
    const run = db.createRun(lockReq({ tokens: 100, cost_usd: 0.1 }));
    db.updateRun(run.run_id, { tokens: 300, cost_usd: 0.35 });
    const got = db.getRun(run.run_id)!;
    expect(got.tokens).toBe(300);
    expect(got.cost_usd).toBeCloseTo(0.35);
    db.close();
  });

  it("aggregates spend per service and per session", async () => {
    const db = await createDatabase(tempDbPath());
    db.createRun(lockReq({ service_name: "a", session_id: "s1", tokens: 100, cost_usd: 1 }));
    db.createRun(lockReq({ service_name: "a", session_id: "s1", tokens: 200, cost_usd: 2 }));
    db.createRun(lockReq({ service_name: "b", session_id: "s2", tokens: 50, cost_usd: 0.5 }));
    db.createRun(lockReq({ service_name: "b", session_id: null as unknown as undefined }));

    const spend = db.getSpend();
    expect(spend.total.tokens).toBe(350);
    expect(spend.total.cost_usd).toBeCloseTo(3.5);
    expect(spend.total.runs).toBe(4);

    const a = spend.services.find((s) => s.key === "a")!;
    expect(a.tokens).toBe(300);
    expect(a.cost_usd).toBeCloseTo(3);
    expect(a.runs).toBe(2);

    const s1 = spend.sessions.find((s) => s.key === "s1")!;
    expect(s1.tokens).toBe(300);
    expect(spend.sessions.find((s) => s.key === null)).toBeUndefined();
    db.close();
  });

  it("filters spend by service", async () => {
    const db = await createDatabase(tempDbPath());
    db.createRun(lockReq({ service_name: "a", tokens: 100, cost_usd: 1 }));
    db.createRun(lockReq({ service_name: "b", tokens: 999, cost_usd: 9 }));
    const spend = db.getSpend({ service: "a" });
    expect(spend.services).toHaveLength(1);
    expect(spend.total.tokens).toBe(100);
    db.close();
  });

  it("persists service budgets through upsertService/getService", async () => {
    const db = await createDatabase(tempDbPath());
    db.upsertService({
      name: "claude",
      expected_cycle_ms: 1000,
      max_silence_ms: 2000,
      budget_tokens: 500_000,
      budget_usd: 5,
    });
    const cfg = db.getService("claude")!;
    expect(cfg.budget_tokens).toBe(500_000);
    expect(cfg.budget_usd).toBeCloseTo(5);
    db.close();
  });

  it("migrates a legacy database that lacks the cost/budget columns", async () => {
    const path = tempDbPath();
    const SQL = await initSqlJs();
    const legacy = new SQL.Database();
    legacy.run(`
      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY, session_id TEXT, service_name TEXT NOT NULL,
        tool_name TEXT, command TEXT, command_family TEXT, resource_kind TEXT,
        resource_id TEXT, status TEXT NOT NULL DEFAULT 'locked',
        severity TEXT NOT NULL DEFAULT 'ok', message TEXT, exit_code INTEGER,
        duration_ms INTEGER, started_at TEXT NOT NULL, last_heartbeat TEXT NOT NULL,
        completed_at TEXT, metadata TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE services (
        name TEXT PRIMARY KEY, expected_cycle_ms INTEGER NOT NULL,
        max_silence_ms INTEGER NOT NULL, endpoints TEXT NOT NULL DEFAULT '[]'
      );
    `);
    legacy.run(
      `INSERT INTO runs (run_id, service_name, status, severity, started_at, last_heartbeat, metadata)
       VALUES ('legacy1', 'svc', 'completed', 'ok', '2026-06-18T00:00:00.000Z', '2026-06-18T00:00:00.000Z', '{}')`,
    );
    writeFileSync(path, Buffer.from(legacy.export()));
    legacy.close();

    const db = await createDatabase(path);
    expect(db.getRun("legacy1")?.tokens).toBeNull();
    const run = db.createRun(lockReq({ tokens: 10, cost_usd: 0.01 }));
    expect(db.getRun(run.run_id)?.tokens).toBe(10);
    db.upsertService({
      name: "svc",
      expected_cycle_ms: 1,
      max_silence_ms: 1,
      budget_usd: 2,
    });
    expect(db.getService("svc")?.budget_usd).toBeCloseTo(2);
    db.close();
  });
});
