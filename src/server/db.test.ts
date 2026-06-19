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
    `agent-heart-verify-${process.pid}-${tempFiles.length}-${Math.floor(performance.now() * 1000)}.db`,
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

describe("PulseDB verification", () => {
  it("defaults verification to null and round-trips it", async () => {
    const db: PulseDB = await createDatabase(tempDbPath());
    const run = db.createRun(lockReq());
    expect(run.verification).toBeNull();
    expect(db.getRun(run.run_id)?.verification).toBeNull();
    db.close();
  });

  it("verifyRun records passed/failed and an optional note", async () => {
    const db = await createDatabase(tempDbPath());
    const run = db.createRun(lockReq());

    const passed = db.verifyRun(run.run_id, "passed");
    expect(passed.verification).toBe("passed");

    const failed = db.verifyRun(run.run_id, "failed", "tests red");
    expect(failed.verification).toBe("failed");
    expect(failed.message).toBe("tests red");
    db.close();
  });

  it("verifyRun throws for an unknown run", async () => {
    const db = await createDatabase(tempDbPath());
    expect(() => db.verifyRun("nope", "passed")).toThrow(/not found/i);
    db.close();
  });

  it("updateRun can set verification to pending (the unlock path)", async () => {
    const db = await createDatabase(tempDbPath());
    const run = db.createRun(lockReq());
    db.updateRun(run.run_id, { status: "completed", verification: "pending" });
    expect(db.getRun(run.run_id)?.verification).toBe("pending");
    db.close();
  });

  it("migrates a legacy database that lacks the verification column", async () => {
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
    expect(db.getRun("legacy1")?.verification).toBeNull();
    const verified = db.verifyRun("legacy1", "passed");
    expect(verified.verification).toBe("passed");
    db.close();
  });
});
