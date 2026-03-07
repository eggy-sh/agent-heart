import { Hono } from "hono";
import {
  HeartbeatRequestSchema,
  HeartbeatAction,
} from "../core/models.js";
import type {
  HeartbeatResponse,
  OverviewResponse,
  RunListResponse,
} from "../core/models.js";
import type { PulseDB } from "./db.js";

export function createApp(db: PulseDB): Hono {
  const app = new Hono();

  // --- Health check ---
  app.get("/api/v1/health", (c) => {
    return c.json({ ok: true, timestamp: new Date().toISOString() });
  });

  // --- Heartbeat ---
  app.post("/api/v1/heartbeat", async (c) => {
    const body = await c.req.json();
    const parsed = HeartbeatRequestSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        { ok: false, error: "Invalid request", details: parsed.error.issues },
        400,
      );
    }

    const req = parsed.data;
    const now = new Date().toISOString();

    try {
      switch (req.action) {
        case HeartbeatAction.LOCK: {
          const run = db.createRun(req);
          const response: HeartbeatResponse = {
            ok: true,
            run_id: run.run_id,
            service_name: run.service_name,
            action: HeartbeatAction.LOCK,
            status: run.status,
            timestamp: now,
          };
          return c.json(response, 201);
        }

        case HeartbeatAction.BEAT: {
          let runId = req.run_id;

          // If no run_id provided, find the latest active run for this service
          if (!runId) {
            const activeRuns = db.listRuns({
              service: req.service_name,
              status: "active",
              limit: 1,
            });
            const lockedRuns = db.listRuns({
              service: req.service_name,
              status: "locked",
              limit: 1,
            });
            const candidate = activeRuns[0] ?? lockedRuns[0];
            if (!candidate) {
              return c.json(
                {
                  ok: false,
                  error: `No active run found for service: ${req.service_name}`,
                },
                404,
              );
            }
            runId = candidate.run_id;
          }

          const existingRun = db.getRun(runId);
          if (!existingRun) {
            return c.json({ ok: false, error: `Run not found: ${runId}` }, 404);
          }

          // Transition locked -> active on first beat
          const newStatus =
            existingRun.status === "locked" ? "active" : existingRun.status;

          const updatedRun = db.updateRun(runId, {
            last_heartbeat: now,
            status: newStatus,
            ...(req.message !== undefined && { message: req.message }),
            ...(req.tool_name !== undefined && { tool_name: req.tool_name }),
            ...(req.metadata !== undefined && { metadata: req.metadata }),
          });

          const response: HeartbeatResponse = {
            ok: true,
            run_id: updatedRun.run_id,
            service_name: updatedRun.service_name,
            action: HeartbeatAction.BEAT,
            status: updatedRun.status,
            timestamp: now,
          };
          return c.json(response);
        }

        case HeartbeatAction.UNLOCK: {
          let runId = req.run_id;

          // If no run_id provided, find the latest active run for this service
          if (!runId) {
            const activeRuns = db.listRuns({
              service: req.service_name,
              status: "active",
              limit: 1,
            });
            const lockedRuns = db.listRuns({
              service: req.service_name,
              status: "locked",
              limit: 1,
            });
            const candidate = activeRuns[0] ?? lockedRuns[0];
            if (!candidate) {
              return c.json(
                {
                  ok: false,
                  error: `No active run found for service: ${req.service_name}`,
                },
                404,
              );
            }
            runId = candidate.run_id;
          }

          const existingRun = db.getRun(runId);
          if (!existingRun) {
            return c.json({ ok: false, error: `Run not found: ${runId}` }, 404);
          }

          const exitCode = req.exit_code ?? 0;
          const status = exitCode === 0 ? "completed" : "failed";
          const severity = exitCode === 0 ? "ok" : "critical";
          const startedAt = new Date(existingRun.started_at).getTime();
          const completedAt = new Date(now).getTime();
          const durationMs = completedAt - startedAt;

          const updatedRun = db.updateRun(runId, {
            status,
            severity,
            exit_code: exitCode,
            duration_ms: durationMs,
            completed_at: now,
            last_heartbeat: now,
            ...(req.message !== undefined && { message: req.message }),
            ...(req.metadata !== undefined && { metadata: req.metadata }),
          });

          const response: HeartbeatResponse = {
            ok: true,
            run_id: updatedRun.run_id,
            service_name: updatedRun.service_name,
            action: HeartbeatAction.UNLOCK,
            status: updatedRun.status,
            timestamp: now,
          };
          return c.json(response);
        }

        default:
          return c.json({ ok: false, error: "Unknown action" }, 400);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal error";
      return c.json({ ok: false, error: message }, 500);
    }
  });

  // --- List runs ---
  app.get("/api/v1/runs", (c) => {
    try {
      const service = c.req.query("service");
      const status = c.req.query("status");
      const session_id = c.req.query("session_id");
      const limitStr = c.req.query("limit");
      const limit = limitStr ? parseInt(limitStr, 10) : undefined;

      const runs = db.listRuns({
        service: service || undefined,
        status: status || undefined,
        session_id: session_id || undefined,
        limit,
      });

      const response: RunListResponse = {
        runs,
        total: runs.length,
      };

      return c.json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal error";
      return c.json({ ok: false, error: message }, 500);
    }
  });

  // --- Get single run ---
  app.get("/api/v1/runs/:id", (c) => {
    try {
      const runId = c.req.param("id");
      const run = db.getRun(runId);

      if (!run) {
        return c.json({ ok: false, error: `Run not found: ${runId}` }, 404);
      }

      return c.json(run);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal error";
      return c.json({ ok: false, error: message }, 500);
    }
  });

  // --- Overview ---
  app.get("/api/v1/overview", (c) => {
    try {
      const services = db.getServiceStates();
      const counts = db.countRuns();

      const response: OverviewResponse = {
        timestamp: new Date().toISOString(),
        services,
        runs: counts,
        endpoints: [], // Endpoint checks are a future enhancement
      };

      return c.json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal error";
      return c.json({ ok: false, error: message }, 500);
    }
  });

  return app;
}
