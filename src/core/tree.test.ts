import { describe, it, expect } from "vitest";
import { buildRunForest, filterForest } from "./tree.js";
import type { Run, RunStatus, Severity } from "./models.js";

function makeRun(
  run_id: string,
  opts: {
    parent_run_id?: string | null;
    status?: RunStatus;
    severity?: Severity;
    started_at?: string;
    service_name?: string;
  } = {},
): Run {
  return {
    run_id,
    session_id: null,
    parent_run_id: opts.parent_run_id ?? null,
    service_name: opts.service_name ?? "svc",
    tool_name: null,
    command: null,
    command_family: null,
    resource_kind: null,
    resource_id: null,
    status: opts.status ?? "active",
    severity: opts.severity ?? "ok",
    message: null,
    exit_code: null,
    duration_ms: null,
    tokens: null,
    cost_usd: null,
    started_at: opts.started_at ?? "2026-06-18T00:00:00.000Z",
    last_heartbeat: opts.started_at ?? "2026-06-18T00:00:00.000Z",
    completed_at: null,
    metadata: {},
  };
}

describe("buildRunForest", () => {
  it("returns all runs as roots when there are no parents", () => {
    const forest = buildRunForest([makeRun("a"), makeRun("b")]);
    expect(forest).toHaveLength(2);
    expect(forest.every((n) => n.children.length === 0)).toBe(true);
    expect(forest.map((n) => n.run.run_id).sort()).toEqual(["a", "b"]);
  });

  it("nests children under their parent", () => {
    const forest = buildRunForest([
      makeRun("root"),
      makeRun("c1", { parent_run_id: "root" }),
      makeRun("c2", { parent_run_id: "root" }),
    ]);
    expect(forest).toHaveLength(1);
    expect(forest[0].run.run_id).toBe("root");
    expect(forest[0].children.map((n) => n.run.run_id).sort()).toEqual([
      "c1",
      "c2",
    ]);
    expect(forest[0].descendantCount).toBe(2);
  });

  it("treats a run whose parent is absent as a root (orphan-safe)", () => {
    const forest = buildRunForest([
      makeRun("child", { parent_run_id: "ghost" }),
    ]);
    expect(forest).toHaveLength(1);
    expect(forest[0].run.run_id).toBe("child");
  });

  it("orders children by started_at ascending", () => {
    const forest = buildRunForest([
      makeRun("root"),
      makeRun("late", {
        parent_run_id: "root",
        started_at: "2026-06-18T00:00:09.000Z",
      }),
      makeRun("early", {
        parent_run_id: "root",
        started_at: "2026-06-18T00:00:01.000Z",
      }),
    ]);
    expect(forest[0].children.map((n) => n.run.run_id)).toEqual([
      "early",
      "late",
    ]);
  });

  it("bubbles a stale descendant up to a warning subtree severity", () => {
    const forest = buildRunForest([
      makeRun("root", { status: "active", severity: "ok" }),
      makeRun("c", {
        parent_run_id: "root",
        status: "stale",
        severity: "warning",
      }),
    ]);
    expect(forest[0].subtreeSeverity).toBe("warning");
  });

  it("bubbles a dead descendant up to a critical subtree severity", () => {
    const forest = buildRunForest([
      makeRun("root", { status: "active", severity: "ok" }),
      makeRun("mid", { parent_run_id: "root", status: "active" }),
      makeRun("leaf", {
        parent_run_id: "mid",
        status: "dead",
        severity: "critical",
      }),
    ]);
    expect(forest[0].subtreeSeverity).toBe("critical");
    expect(forest[0].descendantCount).toBe(2);
  });

  it("keeps subtree severity at ok when nothing is wrong", () => {
    const forest = buildRunForest([
      makeRun("root"),
      makeRun("c", { parent_run_id: "root" }),
    ]);
    expect(forest[0].subtreeSeverity).toBe("ok");
  });

  it("derives severity from status even if the stored severity lags", () => {
    // status is dead but severity field was never updated
    const forest = buildRunForest([
      makeRun("root", { status: "active", severity: "ok" }),
      makeRun("c", { parent_run_id: "root", status: "dead", severity: "ok" }),
    ]);
    expect(forest[0].subtreeSeverity).toBe("critical");
  });

  it("does not infinite-loop on a parent/child cycle", () => {
    const forest = buildRunForest([
      makeRun("a", { parent_run_id: "b" }),
      makeRun("b", { parent_run_id: "a" }),
    ]);
    // Cycle is broken; every run still appears exactly once across the forest.
    const ids: string[] = [];
    const walk = (nodes: typeof forest) => {
      for (const n of nodes) {
        ids.push(n.run.run_id);
        walk(n.children);
      }
    };
    walk(forest);
    expect(ids.sort()).toEqual(["a", "b"]);
  });
});

describe("filterForest", () => {
  // A parent and its differently-named children — the realistic orchestration
  // shape that naive run-level filtering would break.
  const forest = () =>
    buildRunForest([
      makeRun("root", { service_name: "refactor-api", status: "active" }),
      makeRun("c1", {
        parent_run_id: "root",
        service_name: "extract-module",
        status: "completed",
      }),
      makeRun("c2", {
        parent_run_id: "root",
        service_name: "run-tests",
        status: "stale",
      }),
      makeRun("lonely", { service_name: "unrelated", status: "active" }),
    ]);

  it("keeps a whole tree when the root matches, including differently-named children", () => {
    const filtered = filterForest(
      forest(),
      (r) => r.service_name === "refactor-api",
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0].run.run_id).toBe("root");
    // Children are preserved even though their service names differ.
    expect(filtered[0].children.map((n) => n.run.service_name).sort()).toEqual([
      "extract-module",
      "run-tests",
    ]);
  });

  it("keeps the whole tree when only a deep child matches", () => {
    const filtered = filterForest(
      forest(),
      (r) => r.service_name === "run-tests",
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0].run.run_id).toBe("root");
  });

  it("keeps a tree whose stale leaf matches a status filter (rollup stays intact)", () => {
    const filtered = filterForest(forest(), (r) => r.status === "stale");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].run.run_id).toBe("root");
  });

  it("drops trees with no matching node", () => {
    const filtered = filterForest(
      forest(),
      (r) => r.service_name === "nonexistent",
    );
    expect(filtered).toHaveLength(0);
  });
});
