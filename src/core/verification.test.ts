import { describe, it, expect } from "vitest";
import { summarizeVerification } from "./verification.js";
import type { Run, VerificationStatus } from "./models.js";

function makeRun(verification: VerificationStatus | null): Run {
  return {
    run_id: "r" + Math.round(performance.now() * 1000),
    session_id: null,
    service_name: "svc",
    tool_name: null,
    command: null,
    command_family: null,
    resource_kind: null,
    resource_id: null,
    status: "completed",
    severity: "ok",
    message: null,
    exit_code: 0,
    duration_ms: 1,
    verification,
    started_at: "2026-06-18T00:00:00.000Z",
    last_heartbeat: "2026-06-18T00:00:00.000Z",
    completed_at: "2026-06-18T00:00:01.000Z",
    metadata: {},
  };
}

describe("summarizeVerification", () => {
  it("counts pending, passed, and failed", () => {
    const s = summarizeVerification([
      makeRun("pending"),
      makeRun("pending"),
      makeRun("passed"),
      makeRun("failed"),
    ]);
    expect(s).toEqual({ pending: 2, passed: 1, failed: 1 });
  });

  it("ignores runs with no verification state", () => {
    const s = summarizeVerification([makeRun(null), makeRun(null), makeRun("passed")]);
    expect(s).toEqual({ pending: 0, passed: 1, failed: 0 });
  });

  it("returns zeros for an empty list", () => {
    expect(summarizeVerification([])).toEqual({ pending: 0, passed: 0, failed: 0 });
  });
});
