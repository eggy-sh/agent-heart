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

describe("HeartbeatRequestSchema tokens & cost", () => {
  it("accepts tokens and cost_usd", () => {
    const parsed = HeartbeatRequestSchema.parse({
      service_name: "svc",
      action: "beat",
      tokens: 1500,
      cost_usd: 0.42,
    });
    expect(parsed.tokens).toBe(1500);
    expect(parsed.cost_usd).toBeCloseTo(0.42);
  });

  it("leaves them undefined when absent", () => {
    const parsed = HeartbeatRequestSchema.parse({
      service_name: "svc",
      action: "lock",
    });
    expect(parsed.tokens).toBeUndefined();
    expect(parsed.cost_usd).toBeUndefined();
  });

  it("rejects negative tokens or cost", () => {
    expect(() =>
      HeartbeatRequestSchema.parse({
        service_name: "svc",
        action: "beat",
        tokens: -1,
      }),
    ).toThrow();
    expect(() =>
      HeartbeatRequestSchema.parse({
        service_name: "svc",
        action: "beat",
        cost_usd: -0.5,
      }),
    ).toThrow();
  });

  it("rejects non-integer tokens", () => {
    expect(() =>
      HeartbeatRequestSchema.parse({
        service_name: "svc",
        action: "beat",
        tokens: 1.5,
      }),
    ).toThrow();
  });
});
