import { describe, it, expect } from "vitest";
import { HeartbeatRequestSchema } from "./models.js";

describe("HeartbeatRequestSchema parent_run_id", () => {
  it("accepts and preserves parent_run_id", () => {
    const parsed = HeartbeatRequestSchema.parse({
      service_name: "svc",
      action: "lock",
      parent_run_id: "run_parent",
    });
    expect(parsed.parent_run_id).toBe("run_parent");
  });

  it("is optional", () => {
    const parsed = HeartbeatRequestSchema.parse({
      service_name: "svc",
      action: "lock",
    });
    expect(parsed.parent_run_id).toBeUndefined();
  });
});
