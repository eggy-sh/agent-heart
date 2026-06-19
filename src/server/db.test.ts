import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";
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
  return {
    service_name: "svc",
    action: "lock",
    ...overrides,
  };
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
    // An unrelated run that must NOT appear in the subtree.
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
    // Corrupt the data into an a <-> b cycle (not reachable via the API, but
    // getRunTree must not duplicate or hang on it).
    db.updateRun(a.run_id, { parent_run_id: b.run_id });

    const tree = db.getRunTree(a.run_id);
    const ids = tree.map((r) => r.run_id);
    expect(ids[0]).toBe(a.run_id);
    expect(new Set(ids)).toEqual(new Set([a.run_id, b.run_id]));
    expect(ids).toHaveLength(2); // no duplicates
    db.close();
  });

  it("migrates a pre-existing database that lacks the parent_run_id column", async () => {
    const path = tempDbPath();

    // Build a legacy DB whose runs table has no parent_run_id column.
    const SQL = await initSqlJs();
    const legacy = new SQL.Database();
    legacy.run(`
      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY,
        session_id TEXT,
        service_name TEXT NOT NULL,
        tool_name TEXT,
        command TEXT,
        command_family TEXT,
        resource_kind TEXT,
        resource_id TEXT,
        status TEXT NOT NULL DEFAULT 'locked',
        severity TEXT NOT NULL DEFAULT 'ok',
        message TEXT,
        exit_code INTEGER,
        duration_ms INTEGER,
        started_at TEXT NOT NULL,
        last_heartbeat TEXT NOT NULL,
        completed_at TEXT,
        metadata TEXT NOT NULL DEFAULT '{}'
      );
    `);
    legacy.run(
      `INSERT INTO runs (run_id, service_name, status, severity, started_at, last_heartbeat, metadata)
       VALUES ('legacy1', 'svc', 'completed', 'ok', '2026-06-18T00:00:00.000Z', '2026-06-18T00:00:00.000Z', '{}')`,
    );
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, Buffer.from(legacy.export()));
    legacy.close();

    // Opening it through createDatabase should add the column without losing data.
    const db = await createDatabase(path);
    expect(db.getRun("legacy1")?.parent_run_id).toBeNull();

    const child = db.createRun(lockReq({ parent_run_id: "legacy1" }));
    expect(db.getRun(child.run_id)?.parent_run_id).toBe("legacy1");
    db.close();
  });
});
