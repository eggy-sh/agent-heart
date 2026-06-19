import { describe, it, expect } from "vitest";
import { evaluateWatch } from "./watch.js";
import type { Run, RunStatus } from "./models.js";

function makeRun(status: RunStatus): Run {
  return {
    run_id: "r-" + status + Math.round(performance.now() * 1000),
    session_id: "s1",
    parent_run_id: null,
    service_name: "svc",
    tool_name: null,
    command: null,
    command_family: null,
    resource_kind: null,
    resource_id: null,
    status,
    severity: "ok",
    message: null,
    exit_code: null,
    duration_ms: null,
    tokens: null,
    cost_usd: null,
    verification: null,
    started_at: "2026-06-18T00:00:00.000Z",
    last_heartbeat: "2026-06-18T00:00:00.000Z",
    completed_at: null,
    metadata: {},
  };
}

describe("evaluateWatch (settled mode, no --until)", () => {
  it("resolves immediately with exit 0 when there are no runs", () => {
    const v = evaluateWatch([], null);
    expect(v.resolved).toBe(true);
    expect(v.exitCode).toBe(0);
  });

  it("does not resolve while any run is still active", () => {
    const v = evaluateWatch([makeRun("completed"), makeRun("active")], null);
    expect(v.resolved).toBe(false);
  });

  it("resolves with exit 0 when all runs completed", () => {
    const v = evaluateWatch([makeRun("completed"), makeRun("completed")], null);
    expect(v.resolved).toBe(true);
    expect(v.exitCode).toBe(0);
  });

  it("resolves with exit 1 when all terminal but one failed", () => {
    const v = evaluateWatch([makeRun("completed"), makeRun("failed")], null);
    expect(v.resolved).toBe(true);
    expect(v.exitCode).toBe(1);
  });

  it("treats dead as terminal and unsuccessful", () => {
    const v = evaluateWatch([makeRun("dead")], null);
    expect(v.resolved).toBe(true);
    expect(v.exitCode).toBe(1);
  });

  it("does not treat stale as terminal", () => {
    const v = evaluateWatch([makeRun("stale")], null);
    expect(v.resolved).toBe(false);
  });
});

describe("evaluateWatch (--until mode)", () => {
  it("resolves as soon as a run hits an --until state, exit 1 for a bad trigger", () => {
    const v = evaluateWatch(
      [makeRun("dead"), makeRun("active")],
      ["dead"],
    );
    expect(v.resolved).toBe(true);
    expect(v.exitCode).toBe(1);
  });

  it("exits 0 when the --until trigger is a completed run", () => {
    const v = evaluateWatch(
      [makeRun("completed"), makeRun("active")],
      ["completed"],
    );
    expect(v.resolved).toBe(true);
    expect(v.exitCode).toBe(0);
  });

  it("does not resolve until a run reaches an --until state", () => {
    const v = evaluateWatch([makeRun("active"), makeRun("locked")], ["stale"]);
    expect(v.resolved).toBe(false);
  });

  it("can watch for stale runs specifically", () => {
    const v = evaluateWatch([makeRun("active"), makeRun("stale")], ["stale"]);
    expect(v.resolved).toBe(true);
    expect(v.exitCode).toBe(1);
  });
});

describe("evaluateWatch counts", () => {
  it("summarizes statuses", () => {
    const v = evaluateWatch(
      [makeRun("completed"), makeRun("completed"), makeRun("failed")],
      null,
    );
    expect(v.counts.completed).toBe(2);
    expect(v.counts.failed).toBe(1);
  });
});
