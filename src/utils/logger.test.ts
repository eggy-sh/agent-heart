import { describe, it, expect } from "vitest";
import { formatDuration, formatStatus, formatSeverity } from "./logger.js";

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("formatDuration", () => {
  it("renders sub-second durations in ms", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(500)).toBe("500ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("renders seconds, minutes, and hours at the right thresholds", () => {
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(60_000)).toBe("1.0m");
    expect(formatDuration(90_000)).toBe("1.5m");
    expect(formatDuration(3_600_000)).toBe("1.0h");
    expect(formatDuration(7_200_000)).toBe("2.0h");
  });
});

describe("formatStatus", () => {
  it("returns the status word for known states", () => {
    for (const s of ["locked", "active", "completed", "failed", "stale"]) {
      expect(stripAnsi(formatStatus(s))).toBe(s);
    }
  });

  it("highlights dead with padding", () => {
    expect(stripAnsi(formatStatus("dead"))).toBe(" dead ");
  });

  it("passes unknown statuses through unchanged", () => {
    expect(stripAnsi(formatStatus("weird"))).toBe("weird");
  });
});

describe("formatSeverity", () => {
  it("returns the severity word for known levels", () => {
    for (const s of ["ok", "warning", "critical"]) {
      expect(stripAnsi(formatSeverity(s))).toBe(s);
    }
  });
});
