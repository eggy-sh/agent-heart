import { describe, it, expect } from "vitest";
import { HeartbeatRequestSchema, VerifyRequestSchema } from "./models.js";

describe("HeartbeatRequestSchema requires_verification", () => {
  it("accepts requires_verification", () => {
    const parsed = HeartbeatRequestSchema.parse({
      service_name: "svc",
      action: "unlock",
      requires_verification: true,
    });
    expect(parsed.requires_verification).toBe(true);
  });

  it("leaves it undefined when absent", () => {
    const parsed = HeartbeatRequestSchema.parse({
      service_name: "svc",
      action: "unlock",
    });
    expect(parsed.requires_verification).toBeUndefined();
  });
});

describe("VerifyRequestSchema", () => {
  it("accepts passed/failed with an optional message", () => {
    expect(VerifyRequestSchema.parse({ status: "passed" }).status).toBe("passed");
    const f = VerifyRequestSchema.parse({ status: "failed", message: "red" });
    expect(f.status).toBe("failed");
    expect(f.message).toBe("red");
  });

  it("rejects an invalid status", () => {
    expect(() => VerifyRequestSchema.parse({ status: "maybe" })).toThrow();
  });
});
