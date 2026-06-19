import { describe, it, expect } from "vitest";
import { buildRunForest } from "../core/tree.js";
import { renderForest, forestToJson } from "./render-tree.js";
import type { Run, RunStatus, Severity } from "../core/models.js";

// chalk may emit ANSI codes depending on the environment; strip them so
// assertions are about content, not color.
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\[[0-9;]*m/g, "");

function makeRun(
  run_id: string,
  opts: {
    parent_run_id?: string | null;
    status?: RunStatus;
    severity?: Severity;
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
    duration_ms: 100,
    started_at: "2026-06-18T00:00:00.000Z",
    last_heartbeat: "2026-06-18T00:00:00.000Z",
    completed_at: null,
    metadata: {},
  };
}

describe("renderForest", () => {
  it("draws nested children with box-drawing connectors", () => {
    const forest = buildRunForest([
      makeRun("root", { service_name: "orchestrator" }),
      makeRun("a", { parent_run_id: "root" }),
      makeRun("b", { parent_run_id: "root" }),
    ]);
    const out = renderForest(forest).map(stripAnsi);
    expect(out[0]).toContain("orchestrator");
    expect(out.some((l) => l.startsWith("├─ "))).toBe(true);
    expect(out.some((l) => l.startsWith("└─ "))).toBe(true);
  });

  it("annotates a root whose descendant is worse than itself", () => {
    const forest = buildRunForest([
      makeRun("root", { status: "active", severity: "ok" }),
      makeRun("leaf", {
        parent_run_id: "root",
        status: "dead",
        severity: "critical",
      }),
    ]);
    const out = renderForest(forest).map(stripAnsi).join("\n");
    expect(out).toContain("⚠ subtree critical");
  });

  it("does not annotate a healthy tree", () => {
    const forest = buildRunForest([
      makeRun("root"),
      makeRun("leaf", { parent_run_id: "root" }),
    ]);
    const out = renderForest(forest).map(stripAnsi).join("\n");
    expect(out).not.toContain("⚠ subtree");
  });

  it("serializes a nested JSON structure with subtree severity", () => {
    const forest = buildRunForest([
      makeRun("root", { status: "active", severity: "ok" }),
      makeRun("leaf", {
        parent_run_id: "root",
        status: "stale",
        severity: "warning",
      }),
    ]);
    const json = forestToJson(forest);
    expect(json).toHaveLength(1);
    expect(json[0].run_id).toBe("root");
    expect(json[0].subtree_severity).toBe("warning");
    expect(json[0].descendant_count).toBe(1);
    expect(json[0].children[0].run_id).toBe("leaf");
  });
});
