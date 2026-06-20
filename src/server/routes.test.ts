import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import type { Hono } from "hono";
import { createDatabase, type PulseDB } from "./db.js";
import { createApp } from "./routes.js";

const tempFiles: string[] = [];
function tempDbPath(): string {
  const p = join(
    tmpdir(),
    `agent-heart-routes-${process.pid}-${tempFiles.length}-${Math.floor(performance.now() * 1000)}.db`,
  );
  tempFiles.push(p);
  return p;
}

async function harness(): Promise<{ db: PulseDB; app: Hono }> {
  const db = await createDatabase(tempDbPath());
  return { db, app: createApp(db) };
}

const post = (app: Hono, path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const get = (app: Hono, path: string) => app.request(path);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bodyOf = (res: Response): Promise<any> => res.json();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const postJson = async (app: Hono, path: string, body: unknown): Promise<any> =>
  bodyOf(await post(app, path, body));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getJson = async (app: Hono, path: string): Promise<any> =>
  bodyOf(await get(app, path));

afterEach(() => {
  while (tempFiles.length) {
    const p = tempFiles.pop()!;
    if (existsSync(p)) rmSync(p, { force: true });
  }
});

describe("GET /api/v1/health", () => {
  it("reports ok", async () => {
    const { app } = await harness();
    const res = await get(app, "/api/v1/health");
    expect(res.status).toBe(200);
    expect((await bodyOf(res)).ok).toBe(true);
  });
});

describe("POST /api/v1/heartbeat", () => {
  it("lock creates a run (201, locked)", async () => {
    const { app } = await harness();
    const res = await post(app, "/api/v1/heartbeat", { service_name: "svc", action: "lock" });
    expect(res.status).toBe(201);
    const body = await bodyOf(res);
    expect(body.run_id).toBeTruthy();
    expect(body.status).toBe("locked");
  });

  it("beat transitions a locked run to active", async () => {
    const { app } = await harness();
    const lock = await postJson(app, "/api/v1/heartbeat", { service_name: "svc", action: "lock" });
    const beat = await postJson(app, "/api/v1/heartbeat", {
      service_name: "svc",
      action: "beat",
      run_id: lock.run_id,
    });
    expect(beat.status).toBe("active");
  });

  it("beat without run_id resolves the service's latest open run", async () => {
    const { app } = await harness();
    await post(app, "/api/v1/heartbeat", { service_name: "svc", action: "lock" });
    const beat = await postJson(app, "/api/v1/heartbeat", { service_name: "svc", action: "beat" });
    expect(beat.status).toBe("active");
  });

  it("beat on an unknown run_id is 404", async () => {
    const { app } = await harness();
    const res = await post(app, "/api/v1/heartbeat", { service_name: "svc", action: "beat", run_id: "nope" });
    expect(res.status).toBe(404);
  });

  it("beat with no open run for the service is 404", async () => {
    const { app } = await harness();
    const res = await post(app, "/api/v1/heartbeat", { service_name: "ghost", action: "beat" });
    expect(res.status).toBe(404);
  });

  it("unlock exit 0 completes; exit 1 fails (critical)", async () => {
    const { app, db } = await harness();
    const l1 = await postJson(app, "/api/v1/heartbeat", { service_name: "a", action: "lock" });
    const ok = await postJson(app, "/api/v1/heartbeat", { service_name: "a", action: "unlock", run_id: l1.run_id, exit_code: 0 });
    expect(ok.status).toBe("completed");

    const l2 = await postJson(app, "/api/v1/heartbeat", { service_name: "b", action: "lock" });
    const bad = await postJson(app, "/api/v1/heartbeat", { service_name: "b", action: "unlock", run_id: l2.run_id, exit_code: 1 });
    expect(bad.status).toBe("failed");
    expect(db.getRun(l2.run_id)?.severity).toBe("critical");
  });

  it("unlock --needs-verify sets verification pending", async () => {
    const { app, db } = await harness();
    const l = await postJson(app, "/api/v1/heartbeat", { service_name: "v", action: "lock" });
    await post(app, "/api/v1/heartbeat", {
      service_name: "v",
      action: "unlock",
      run_id: l.run_id,
      exit_code: 0,
      requires_verification: true,
    });
    expect(db.getRun(l.run_id)?.verification).toBe("pending");
  });

  it("rejects an invalid body with 400", async () => {
    const { app } = await harness();
    const res = await post(app, "/api/v1/heartbeat", { action: "lock" }); // missing service_name
    expect(res.status).toBe(400);
  });
});

describe("GET /api/v1/runs", () => {
  it("lists and filters runs", async () => {
    const { app, db } = await harness();
    db.createRun({ service_name: "x", action: "lock" });
    db.createRun({ service_name: "y", action: "lock" });

    const all = await getJson(app, "/api/v1/runs");
    expect(all.total).toBe(2);

    const filtered = await getJson(app, "/api/v1/runs?service=x");
    expect(filtered.total).toBe(1);
    expect(filtered.runs[0].service_name).toBe("x");
  });
});

describe("GET /api/v1/runs/:id and /tree", () => {
  it("returns a single run, 404 when missing", async () => {
    const { app, db } = await harness();
    const run = db.createRun({ service_name: "svc", action: "lock" });
    expect((await get(app, `/api/v1/runs/${run.run_id}`)).status).toBe(200);
    expect((await get(app, "/api/v1/runs/missing")).status).toBe(404);
  });

  it("returns a subtree, 404 for an unknown root", async () => {
    const { app, db } = await harness();
    const root = db.createRun({ service_name: "svc", action: "lock" });
    db.createRun({ service_name: "sub", action: "lock", parent_run_id: root.run_id });

    const tree = await getJson(app, `/api/v1/runs/${root.run_id}/tree`);
    expect(tree.total).toBe(2);
    expect((await get(app, "/api/v1/runs/missing/tree")).status).toBe(404);
  });
});

describe("POST /api/v1/runs/:id/verify", () => {
  it("records a verdict, 404 missing, 400 bad body", async () => {
    const { app, db } = await harness();
    const run = db.createRun({ service_name: "svc", action: "lock" });

    const ok = await post(app, `/api/v1/runs/${run.run_id}/verify`, { status: "passed" });
    expect(ok.status).toBe(200);
    expect((await bodyOf(ok)).verification).toBe("passed");

    expect((await post(app, "/api/v1/runs/nope/verify", { status: "passed" })).status).toBe(404);
    expect((await post(app, `/api/v1/runs/${run.run_id}/verify`, { status: "maybe" })).status).toBe(400);
  });
});

describe("GET /api/v1/overview", () => {
  it("summarizes services and run counts", async () => {
    const { app, db } = await harness();
    const r = db.createRun({ service_name: "svc", action: "lock" });
    db.updateRun(r.run_id, { status: "completed", exit_code: 0 });

    const ov = await getJson(app, "/api/v1/overview");
    expect(ov.runs.completed).toBe(1);
    expect(ov.services.some((s: { service_name: string }) => s.service_name === "svc")).toBe(true);
    expect(ov.endpoints).toEqual([]);
  });
});

describe("GET /api/v1/spend", () => {
  it("aggregates spend and evaluates the service budget", async () => {
    const { app, db } = await harness();
    db.upsertService({ name: "claude", expected_cycle_ms: 1, max_silence_ms: 1, budget_usd: 1 });
    const r = db.createRun({ service_name: "claude", action: "lock", cost_usd: 1.5, tokens: 100 });
    db.updateRun(r.run_id, { status: "completed", exit_code: 0 });

    const spend = await getJson(app, "/api/v1/spend");
    expect(spend.total.cost_usd).toBeCloseTo(1.5);
    const claude = spend.services.find((s: { key: string }) => s.key === "claude");
    expect(claude.budget.severity).toBe("critical"); // 1.5 / 1.0 over budget
    expect(claude.budget.cost_usd.pct).toBe(150);
  });
});
