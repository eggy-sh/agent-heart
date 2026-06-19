import { describe, it, expect } from "vitest";
import { redactCommand, redactMetadata, type RedactConfig } from "./redact.js";

const CFG: RedactConfig = {
  enabled: true,
  patterns: ["password", "token", "secret", "api_key"],
};

describe("redactCommand", () => {
  it("redacts --flag value and --flag=value secrets", () => {
    expect(redactCommand("psql --password hunter2 -h db", CFG)).toBe(
      "psql --password [REDACTED] -h db",
    );
    expect(redactCommand("api --token=abc123 list", CFG)).toBe(
      "api --token=[REDACTED] list",
    );
  });

  it("redacts KEY=value environment style", () => {
    expect(redactCommand("TOKEN=abc123 ./run.sh", CFG)).toBe(
      "TOKEN=[REDACTED] ./run.sh",
    );
  });

  it("redacts multiple secrets in one command", () => {
    expect(
      redactCommand("svc --password p1 --api_key k1 --verbose", CFG),
    ).toBe("svc --password [REDACTED] --api_key [REDACTED] --verbose");
  });

  it("is case-insensitive on the flag name", () => {
    expect(redactCommand("x --PASSWORD secret123", CFG)).toBe(
      "x --PASSWORD [REDACTED]",
    );
  });

  it("leaves non-sensitive commands untouched", () => {
    expect(redactCommand("gh pr list --repo acme/api", CFG)).toBe(
      "gh pr list --repo acme/api",
    );
  });

  it("is a no-op when redaction is disabled", () => {
    const disabled: RedactConfig = { enabled: false, patterns: ["password"] };
    expect(redactCommand("x --password hunter2", disabled)).toBe(
      "x --password hunter2",
    );
  });
});

describe("redactMetadata", () => {
  it("redacts values under sensitive keys, keeps the rest", () => {
    const out = redactMetadata(
      { auth_token: "abc", duration_ms: "1200", command: "ls" },
      CFG,
    );
    expect(out.auth_token).toBe("[REDACTED]");
    expect(out.duration_ms).toBe("1200");
    expect(out.command).toBe("ls");
  });

  it("is a no-op when disabled", () => {
    const out = redactMetadata(
      { token: "abc" },
      { enabled: false, patterns: ["token"] },
    );
    expect(out.token).toBe("abc");
  });
});
