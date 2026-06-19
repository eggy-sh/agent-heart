import { describe, it, expect } from "vitest";
import { classifyFailure } from "./classify.js";

describe("classifyFailure", () => {
  it("flags explicit permission errors", () => {
    expect(classifyFailure("Error: permission denied")).toBe("permission");
    expect(classifyFailure("access denied to resource")).toBe("permission");
  });

  it("flags HTTP 401/403 as permission failures", () => {
    expect(classifyFailure("server returned HTTP 403 Forbidden")).toBe("permission");
    expect(classifyFailure("got 401 Unauthorized")).toBe("permission");
  });

  it("flags unauthorized / not authorized phrasing", () => {
    expect(classifyFailure("Unauthorized")).toBe("permission");
    expect(classifyFailure("user is not authorized to perform this action")).toBe(
      "permission",
    );
  });

  it("flags POSIX EPERM/EACCES codes", () => {
    expect(classifyFailure("open '/etc/x': EACCES")).toBe("permission");
    expect(classifyFailure("operation failed: EPERM")).toBe("permission");
  });

  it("is case-insensitive for word patterns", () => {
    expect(classifyFailure("PERMISSION DENIED")).toBe("permission");
  });

  it("returns undefined for empty or unrelated stderr", () => {
    expect(classifyFailure("")).toBeUndefined();
    expect(classifyFailure("file not found")).toBeUndefined();
    expect(classifyFailure("SyntaxError: unexpected token")).toBeUndefined();
  });

  it("respects word boundaries on numeric codes (4030 is not 403)", () => {
    expect(classifyFailure("exited with code 4030")).toBeUndefined();
    expect(classifyFailure("error 14010 occurred")).toBeUndefined();
  });
});
