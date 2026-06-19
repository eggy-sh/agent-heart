import { describe, it, expect } from "vitest";
import { resolveParentRunId, PARENT_RUN_ID_ENV } from "./parentage.js";

describe("resolveParentRunId", () => {
  it("prefers an explicit value over the environment", () => {
    const env = { [PARENT_RUN_ID_ENV]: "from_env" };
    expect(resolveParentRunId("explicit", env)).toBe("explicit");
  });

  it("falls back to the environment variable", () => {
    const env = { [PARENT_RUN_ID_ENV]: "from_env" };
    expect(resolveParentRunId(undefined, env)).toBe("from_env");
  });

  it("returns undefined when neither is set", () => {
    expect(resolveParentRunId(undefined, {})).toBeUndefined();
  });

  it("treats blank values as absent", () => {
    expect(resolveParentRunId("   ", {})).toBeUndefined();
    expect(resolveParentRunId(undefined, { [PARENT_RUN_ID_ENV]: "  " })).toBeUndefined();
  });
});
