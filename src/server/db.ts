import Database from "better-sqlite3";
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

export function createDatabase(dbPath: string): PulseDB {
  const db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

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

  // Prepared statements
  const insertRun = db.prepare(`
    INSERT INTO runs (run_id, session_id, service_name, tool_name, command, command_family,
      resource_kind, resource_id, status, severity, message, exit_code, duration_ms,
      started_at, last_heartbeat, completed_at, metadata)
    VALUES (@run_id, @session_id, @service_name, @tool_name, @command, @command_family,
      @resource_kind, @resource_id, @status, @severity, @message, @exit_code, @duration_ms,
      @started_at, @last_heartbeat, @completed_at, @metadata)
  `);

  const selectRun = db.prepare(`SELECT * FROM runs WHERE run_id = ?`);

  const selectActiveRuns = db.prepare(
    `SELECT * FROM runs WHERE status IN ('locked', 'active') ORDER BY last_heartbeat DESC`,
  );

  const selectLatestActiveRun = db.prepare(
    `SELECT * FROM runs WHERE service_name = ? AND status IN ('locked', 'active')
     ORDER BY last_heartbeat DESC LIMIT 1`,
  );

  const upsertServiceStmt = db.prepare(`
    INSERT INTO services (name, expected_cycle_ms, max_silence_ms, endpoints)
    VALUES (@name, @expected_cycle_ms, @max_silence_ms, @endpoints)
    ON CONFLICT(name) DO UPDATE SET
      expected_cycle_ms = @expected_cycle_ms,
      max_silence_ms = @max_silence_ms,
      endpoints = @endpoints
  `);

  const selectService = db.prepare(`SELECT * FROM services WHERE name = ?`);

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

      insertRun.run({
        ...run,
        metadata: JSON.stringify(run.metadata),
      });

      return run;
    },

    updateRun(runId: string, updates: Partial<Run>): Run {
      const existing = selectRun.get(runId) as RunRow | undefined;
      if (!existing) {
        throw new Error(`Run not found: ${runId}`);
      }

      const currentRun = rowToRun(existing);

      // Build SET clause dynamically from the updates provided
      const fields: string[] = [];
      const values: Record<string, unknown> = { run_id: runId };

      for (const [key, value] of Object.entries(updates)) {
        if (key === "run_id") continue; // Never update the primary key
        if (key === "metadata") {
          fields.push(`${key} = @${key}`);
          values[key] = JSON.stringify(value);
        } else {
          fields.push(`${key} = @${key}`);
          values[key] = value;
        }
      }

      if (fields.length > 0) {
        const sql = `UPDATE runs SET ${fields.join(", ")} WHERE run_id = @run_id`;
        db.prepare(sql).run(values);
      }

      const updated = selectRun.get(runId) as RunRow;
      return rowToRun(updated);
    },

    getRun(runId: string): Run | null {
      const row = selectRun.get(runId) as RunRow | undefined;
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
        conditions.push("service_name = @service");
        params.service = filters.service;
      }
      if (filters?.status) {
        conditions.push("status = @status");
        params.status = filters.status;
      }
      if (filters?.session_id) {
        conditions.push("session_id = @session_id");
        params.session_id = filters.session_id;
      }

      const where =
        conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const limit = filters?.limit ?? 100;

      const sql = `SELECT * FROM runs ${where} ORDER BY last_heartbeat DESC LIMIT @limit`;
      params.limit = limit;

      const rows = db.prepare(sql).all(params) as RunRow[];
      return rows.map(rowToRun);
    },

    getActiveRuns(): Run[] {
      const rows = selectActiveRuns.all() as RunRow[];
      return rows.map(rowToRun);
    },

    getServiceStates(): ServiceState[] {
      // Get all known service names from both runs and services tables
      const serviceNames = db
        .prepare(
          `SELECT DISTINCT name AS service_name FROM services
           UNION
           SELECT DISTINCT service_name FROM runs`,
        )
        .all() as Array<{ service_name: string }>;

      return serviceNames.map(({ service_name }) => {
        const serviceConfig = selectService.get(service_name) as
          | ServiceRow
          | undefined;

        const expected_cycle_ms = serviceConfig?.expected_cycle_ms ?? 300_000;
        const max_silence_ms = serviceConfig?.max_silence_ms ?? 600_000;

        const counts = db
          .prepare(
            `SELECT
              COALESCE(SUM(CASE WHEN status IN ('locked', 'active') THEN 1 ELSE 0 END), 0) as active,
              COALESCE(SUM(CASE WHEN status = 'stale' THEN 1 ELSE 0 END), 0) as stale,
              COALESCE(SUM(CASE WHEN status = 'dead' THEN 1 ELSE 0 END), 0) as dead
            FROM runs WHERE service_name = ?`,
          )
          .get(service_name) as { active: number; stale: number; dead: number };

        const lastBeat = db
          .prepare(
            `SELECT last_heartbeat FROM runs WHERE service_name = ?
             ORDER BY last_heartbeat DESC LIMIT 1`,
          )
          .get(service_name) as { last_heartbeat: string } | undefined;

        // Determine overall service status and severity
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
      const row = db
        .prepare(
          `SELECT
            COALESCE(SUM(CASE WHEN status IN ('locked', 'active') THEN 1 ELSE 0 END), 0) as active,
            COALESCE(SUM(CASE WHEN status = 'stale' THEN 1 ELSE 0 END), 0) as stale,
            COALESCE(SUM(CASE WHEN status = 'dead' THEN 1 ELSE 0 END), 0) as dead,
            COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) as completed,
            COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed
          FROM runs`,
        )
        .get() as {
        active: number;
        stale: number;
        dead: number;
        completed: number;
        failed: number;
      };

      return row;
    },

    markStale(runId: string): void {
      db.prepare(
        `UPDATE runs SET status = 'stale', severity = 'warning' WHERE run_id = ?`,
      ).run(runId);
    },

    markDead(runId: string): void {
      db.prepare(
        `UPDATE runs SET status = 'dead', severity = 'critical' WHERE run_id = ?`,
      ).run(runId);
    },

    getStaleRuns(defaultCycleMs: number): Run[] {
      // Find locked/active runs whose last heartbeat exceeds expected cycle time
      // Use per-service config if available, otherwise fall back to default
      const rows = db
        .prepare(
          `SELECT r.* FROM runs r
           LEFT JOIN services s ON r.service_name = s.name
           WHERE r.status IN ('locked', 'active')
             AND (
               (julianday('now') - julianday(r.last_heartbeat)) * 86400000
               > COALESCE(s.expected_cycle_ms, @defaultCycleMs)
             )`,
        )
        .all({ defaultCycleMs }) as RunRow[];

      return rows.map(rowToRun);
    },

    getDeadRuns(defaultSilenceMs: number): Run[] {
      // Find locked/active/stale runs whose last heartbeat exceeds max silence time
      const rows = db
        .prepare(
          `SELECT r.* FROM runs r
           LEFT JOIN services s ON r.service_name = s.name
           WHERE r.status IN ('locked', 'active', 'stale')
             AND (
               (julianday('now') - julianday(r.last_heartbeat)) * 86400000
               > COALESCE(s.max_silence_ms, @defaultSilenceMs)
             )`,
        )
        .all({ defaultSilenceMs }) as RunRow[];

      return rows.map(rowToRun);
    },

    upsertService(config: ServiceConfig): void {
      upsertServiceStmt.run({
        name: config.name,
        expected_cycle_ms: config.expected_cycle_ms,
        max_silence_ms: config.max_silence_ms,
        endpoints: JSON.stringify(config.endpoints ?? []),
      });
    },

    getService(name: string): ServiceConfig | null {
      const row = selectService.get(name) as ServiceRow | undefined;
      return row ? rowToServiceConfig(row) : null;
    },

    close(): void {
      db.close();
    },
  };

  return pulseDb;
}
