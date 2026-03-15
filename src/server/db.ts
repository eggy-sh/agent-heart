import initSqlJs, { type Database as SqlJsDatabase, type BindParams } from "sql.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { nanoid } from "nanoid";
import type {
  Run,
  RunStatus,
  Severity,
  ServiceState,
  ServiceConfig,
  HeartbeatRequest,
} from "../core/models.js";

export interface PulseDB {
  createRun(req: HeartbeatRequest): Run;
  updateRun(runId: string, updates: Partial<Run>): Run;
  getRun(runId: string): Run | null;
  listRuns(filters?: {
    service?: string;
    status?: string;
    session_id?: string;
    limit?: number;
  }): Run[];
  getActiveRuns(): Run[];
  getServiceStates(): ServiceState[];
  countRuns(): {
    active: number;
    stale: number;
    dead: number;
    completed: number;
    failed: number;
  };
  markStale(runId: string): void;
  markDead(runId: string): void;
  getStaleRuns(defaultCycleMs: number): Run[];
  getDeadRuns(defaultSilenceMs: number): Run[];
  upsertService(config: ServiceConfig): void;
  getRecentRuns(serviceName: string, limit: number): Run[];
  getService(name: string): ServiceConfig | null;
  close(): void;
}

interface RunRow {
  run_id: string;
  session_id: string | null;
  service_name: string;
  tool_name: string | null;
  command: string | null;
  command_family: string | null;
  resource_kind: string | null;
  resource_id: string | null;
  status: string;
  severity: string;
  message: string | null;
  exit_code: number | null;
  duration_ms: number | null;
  started_at: string;
  last_heartbeat: string;
  completed_at: string | null;
  metadata: string;
}

interface ServiceRow {
  name: string;
  expected_cycle_ms: number;
  max_silence_ms: number;
  endpoints: string;
}

function rowToRun(row: RunRow): Run {
  return {
    run_id: row.run_id,
    session_id: row.session_id,
    service_name: row.service_name,
    tool_name: row.tool_name,
    command: row.command,
    command_family: row.command_family,
    resource_kind: row.resource_kind,
    resource_id: row.resource_id,
    status: row.status as RunStatus,
    severity: row.severity as Severity,
    message: row.message,
    exit_code: row.exit_code,
    duration_ms: row.duration_ms,
    started_at: row.started_at,
    last_heartbeat: row.last_heartbeat,
    completed_at: row.completed_at,
    metadata: JSON.parse(row.metadata || "{}") as Record<string, string>,
  };
}

function rowToServiceConfig(row: ServiceRow): ServiceConfig {
  return {
    name: row.name,
    expected_cycle_ms: row.expected_cycle_ms,
    max_silence_ms: row.max_silence_ms,
    endpoints: JSON.parse(row.endpoints || "[]"),
  };
}

/** Run a SELECT and return all matching rows as objects */
function queryAll<T>(db: SqlJsDatabase, sql: string, params?: BindParams): T[] {
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  const rows: T[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as T);
  }
  stmt.free();
  return rows;
}

/** Run a SELECT and return the first matching row as an object */
function queryOne<T>(db: SqlJsDatabase, sql: string, params?: BindParams): T | undefined {
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  let result: T | undefined;
  if (stmt.step()) {
    result = stmt.getAsObject() as T;
  }
  stmt.free();
  return result;
}

export async function createDatabase(dbPath: string): Promise<PulseDB> {
  const SQL = await initSqlJs();

  // Load existing database or create new
  let db: SqlJsDatabase;
  if (existsSync(dbPath)) {
    const fileBuffer = readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  // Enable foreign keys
  db.run("PRAGMA foreign_keys = ON");

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
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

    CREATE INDEX IF NOT EXISTS idx_runs_service_name ON runs(service_name);
    CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
    CREATE INDEX IF NOT EXISTS idx_runs_session_id ON runs(session_id);
    CREATE INDEX IF NOT EXISTS idx_runs_last_heartbeat ON runs(last_heartbeat);

    CREATE TABLE IF NOT EXISTS services (
      name TEXT PRIMARY KEY,
      expected_cycle_ms INTEGER NOT NULL,
      max_silence_ms INTEGER NOT NULL,
      endpoints TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS endpoints (
      endpoint_id TEXT PRIMARY KEY,
      service_name TEXT NOT NULL,
      url TEXT NOT NULL,
      method TEXT NOT NULL DEFAULT 'GET',
      expected_status INTEGER NOT NULL DEFAULT 200,
      interval_ms INTEGER NOT NULL DEFAULT 60000,
      last_check TEXT,
      last_status INTEGER,
      response_time_ms INTEGER,
      healthy INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (service_name) REFERENCES services(name)
    );
  `);

  function save(): void {
    const data = db.export();
    writeFileSync(dbPath, Buffer.from(data));
  }

  // Persist initial schema
  save();

  const pulseDb: PulseDB = {
    createRun(req: HeartbeatRequest): Run {
      const now = new Date().toISOString();
      const run: Run = {
        run_id: nanoid(),
        session_id: req.session_id ?? null,
        service_name: req.service_name,
        tool_name: req.tool_name ?? null,
        command: req.command ?? null,
        command_family: req.command_family ?? null,
        resource_kind: req.resource_kind ?? null,
        resource_id: req.resource_id ?? null,
        status: "locked",
        severity: "ok",
        message: req.message ?? null,
        exit_code: null,
        duration_ms: null,
        started_at: now,
        last_heartbeat: now,
        completed_at: null,
        metadata: req.metadata ?? {},
      };

      db.run(
        `INSERT INTO runs (run_id, session_id, service_name, tool_name, command, command_family,
          resource_kind, resource_id, status, severity, message, exit_code, duration_ms,
          started_at, last_heartbeat, completed_at, metadata)
        VALUES ($run_id, $session_id, $service_name, $tool_name, $command, $command_family,
          $resource_kind, $resource_id, $status, $severity, $message, $exit_code, $duration_ms,
          $started_at, $last_heartbeat, $completed_at, $metadata)`,
        {
          $run_id: run.run_id,
          $session_id: run.session_id,
          $service_name: run.service_name,
          $tool_name: run.tool_name,
          $command: run.command,
          $command_family: run.command_family,
          $resource_kind: run.resource_kind,
          $resource_id: run.resource_id,
          $status: run.status,
          $severity: run.severity,
          $message: run.message,
          $exit_code: run.exit_code,
          $duration_ms: run.duration_ms,
          $started_at: run.started_at,
          $last_heartbeat: run.last_heartbeat,
          $completed_at: run.completed_at,
          $metadata: JSON.stringify(run.metadata),
        } as BindParams,
      );

      save();
      return run;
    },

    updateRun(runId: string, updates: Partial<Run>): Run {
      const existing = queryOne<RunRow>(db,
        `SELECT * FROM runs WHERE run_id = $run_id`,
        { $run_id: runId } as BindParams,
      );
      if (!existing) {
        throw new Error(`Run not found: ${runId}`);
      }

      const fields: string[] = [];
      const values: Record<string, unknown> = { $run_id: runId };

      for (const [key, value] of Object.entries(updates)) {
        if (key === "run_id") continue;
        if (key === "metadata") {
          fields.push(`${key} = $${key}`);
          values[`$${key}`] = JSON.stringify(value);
        } else {
          fields.push(`${key} = $${key}`);
          values[`$${key}`] = value;
        }
      }

      if (fields.length > 0) {
        const sql = `UPDATE runs SET ${fields.join(", ")} WHERE run_id = $run_id`;
        db.run(sql, values as BindParams);
        save();
      }

      const updated = queryOne<RunRow>(db,
        `SELECT * FROM runs WHERE run_id = $run_id`,
        { $run_id: runId } as BindParams,
      );
      return rowToRun(updated!);
    },

    getRun(runId: string): Run | null {
      const row = queryOne<RunRow>(db,
        `SELECT * FROM runs WHERE run_id = $run_id`,
        { $run_id: runId } as BindParams,
      );
      return row ? rowToRun(row) : null;
    },

    listRuns(filters?: {
      service?: string;
      status?: string;
      session_id?: string;
      limit?: number;
    }): Run[] {
      const conditions: string[] = [];
      const params: Record<string, unknown> = {};

      if (filters?.service) {
        conditions.push("service_name = $service");
        params.$service = filters.service;
      }
      if (filters?.status) {
        conditions.push("status = $status");
        params.$status = filters.status;
      }
      if (filters?.session_id) {
        conditions.push("session_id = $session_id");
        params.$session_id = filters.session_id;
      }

      const where =
        conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const limit = filters?.limit ?? 100;

      const sql = `SELECT * FROM runs ${where} ORDER BY last_heartbeat DESC LIMIT $limit`;
      params.$limit = limit;

      const rows = queryAll<RunRow>(db, sql, params as BindParams);
      return rows.map(rowToRun);
    },

    getActiveRuns(): Run[] {
      const rows = queryAll<RunRow>(db,
        `SELECT * FROM runs WHERE status IN ('locked', 'active') ORDER BY last_heartbeat DESC`,
      );
      return rows.map(rowToRun);
    },

    getRecentRuns(serviceName: string, limit: number): Run[] {
      const rows = queryAll<RunRow>(db,
        `SELECT * FROM runs WHERE service_name = $service
         AND status IN ('completed', 'failed')
         ORDER BY started_at DESC LIMIT $limit`,
        { $service: serviceName, $limit: limit } as BindParams,
      );
      return rows.map(rowToRun);
    },

    getServiceStates(): ServiceState[] {
      const serviceNames = queryAll<{ service_name: string }>(db,
        `SELECT DISTINCT name AS service_name FROM services
         UNION
         SELECT DISTINCT service_name FROM runs`,
      );

      return serviceNames.map(({ service_name }) => {
        const serviceConfig = queryOne<ServiceRow>(db,
          `SELECT * FROM services WHERE name = $name`,
          { $name: service_name } as BindParams,
        );

        const expected_cycle_ms = serviceConfig?.expected_cycle_ms ?? 300_000;
        const max_silence_ms = serviceConfig?.max_silence_ms ?? 600_000;

        const counts = queryOne<{ active: number; stale: number; dead: number }>(db,
          `SELECT
            COALESCE(SUM(CASE WHEN status IN ('locked', 'active') THEN 1 ELSE 0 END), 0) as active,
            COALESCE(SUM(CASE WHEN status = 'stale' THEN 1 ELSE 0 END), 0) as stale,
            COALESCE(SUM(CASE WHEN status = 'dead' THEN 1 ELSE 0 END), 0) as dead
          FROM runs WHERE service_name = $service_name`,
          { $service_name: service_name } as BindParams,
        ) ?? { active: 0, stale: 0, dead: 0 };

        const lastBeat = queryOne<{ last_heartbeat: string }>(db,
          `SELECT last_heartbeat FROM runs WHERE service_name = $service_name
           ORDER BY last_heartbeat DESC LIMIT 1`,
          { $service_name: service_name } as BindParams,
        );

        // Consecutive failure detection
        const recentRuns = queryAll<RunRow>(db,
          `SELECT * FROM runs WHERE service_name = $service
           AND status IN ('completed', 'failed')
           ORDER BY started_at DESC LIMIT 5`,
          { $service: service_name } as BindParams,
        ).map(rowToRun);

        let consecutiveFailures = 0;
        for (const run of recentRuns) {
          if (run.status === "failed" && run.exit_code !== null && run.exit_code !== 0) {
            consecutiveFailures++;
          } else {
            break;
          }
        }

        let status: RunStatus = "completed";
        let severity: Severity = "ok";

        if (counts.dead > 0) {
          status = "dead";
          severity = "critical";
        } else if (counts.stale > 0) {
          status = "stale";
          severity = "warning";
        } else if (counts.active > 0) {
          status = "active";
          severity = "ok";
        }

        // Escalate severity if looping
        if (consecutiveFailures >= 3 && severity !== "critical") {
          severity = "critical";
        }

        return {
          service_name,
          status,
          severity,
          active_runs: counts.active,
          stale_runs: counts.stale,
          dead_runs: counts.dead,
          last_heartbeat: lastBeat?.last_heartbeat ?? null,
          expected_cycle_ms,
          max_silence_ms,
          consecutive_failures: consecutiveFailures,
        };
      });
    },

    countRuns(): {
      active: number;
      stale: number;
      dead: number;
      completed: number;
      failed: number;
    } {
      const row = queryOne<{
        active: number;
        stale: number;
        dead: number;
        completed: number;
        failed: number;
      }>(db,
        `SELECT
          COALESCE(SUM(CASE WHEN status IN ('locked', 'active') THEN 1 ELSE 0 END), 0) as active,
          COALESCE(SUM(CASE WHEN status = 'stale' THEN 1 ELSE 0 END), 0) as stale,
          COALESCE(SUM(CASE WHEN status = 'dead' THEN 1 ELSE 0 END), 0) as dead,
          COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) as completed,
          COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed
        FROM runs`,
      );

      return row ?? { active: 0, stale: 0, dead: 0, completed: 0, failed: 0 };
    },

    markStale(runId: string): void {
      db.run(
        `UPDATE runs SET status = 'stale', severity = 'warning' WHERE run_id = $run_id`,
        { $run_id: runId } as BindParams,
      );
      save();
    },

    markDead(runId: string): void {
      db.run(
        `UPDATE runs SET status = 'dead', severity = 'critical' WHERE run_id = $run_id`,
        { $run_id: runId } as BindParams,
      );
      save();
    },

    getStaleRuns(defaultCycleMs: number): Run[] {
      const rows = queryAll<RunRow>(db,
        `SELECT r.* FROM runs r
         LEFT JOIN services s ON r.service_name = s.name
         WHERE r.status IN ('locked', 'active')
           AND (
             (julianday('now') - julianday(r.last_heartbeat)) * 86400000
             > COALESCE(s.expected_cycle_ms, $defaultCycleMs)
           )`,
        { $defaultCycleMs: defaultCycleMs } as BindParams,
      );

      return rows.map(rowToRun);
    },

    getDeadRuns(defaultSilenceMs: number): Run[] {
      const rows = queryAll<RunRow>(db,
        `SELECT r.* FROM runs r
         LEFT JOIN services s ON r.service_name = s.name
         WHERE r.status IN ('locked', 'active', 'stale')
           AND (
             (julianday('now') - julianday(r.last_heartbeat)) * 86400000
             > COALESCE(s.max_silence_ms, $defaultSilenceMs)
           )`,
        { $defaultSilenceMs: defaultSilenceMs } as BindParams,
      );

      return rows.map(rowToRun);
    },

    upsertService(config: ServiceConfig): void {
      db.run(
        `INSERT INTO services (name, expected_cycle_ms, max_silence_ms, endpoints)
        VALUES ($name, $expected_cycle_ms, $max_silence_ms, $endpoints)
        ON CONFLICT(name) DO UPDATE SET
          expected_cycle_ms = $expected_cycle_ms,
          max_silence_ms = $max_silence_ms,
          endpoints = $endpoints`,
        {
          $name: config.name,
          $expected_cycle_ms: config.expected_cycle_ms,
          $max_silence_ms: config.max_silence_ms,
          $endpoints: JSON.stringify(config.endpoints ?? []),
        } as BindParams,
      );
      save();
    },

    getService(name: string): ServiceConfig | null {
      const row = queryOne<ServiceRow>(db,
        `SELECT * FROM services WHERE name = $name`,
        { $name: name } as BindParams,
      );
      return row ? rowToServiceConfig(row) : null;
    },

    close(): void {
      save();
      db.close();
    },
  };

  return pulseDb;
}
