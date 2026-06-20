import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  commandFamily,
  extractCommand,
  handlePreToolUse,
  handlePostToolUse,
  handleSessionStart,
  handleSessionEnd,
  resetClient,
} from "./claude-code.js";
import { PulseClient } from "../core/client.js";

describe("commandFamily", () => {
  it("maps tool names to families", () => {
    expect(commandFamily("Bash")).toBe("shell");
    expect(commandFamily("bash")).toBe("shell");
    for (const t of ["Read", "Write", "Edit", "Glob", "Grep"]) {
      expect(commandFamily(t)).toBe("filesystem");
    }
    expect(commandFamily("mcp__github__list")).toBe("mcp");
    expect(commandFamily("WebFetch")).toBe("tool");
  });
});

describe("extractCommand", () => {
  it("uses the command field for shell tools", () => {
    expect(extractCommand("Bash", { command: "ls -la" })).toBe("ls -la");
  });
  it("uses file_path / path for file tools", () => {
    expect(extractCommand("Read", { file_path: "/tmp/x" })).toBe("Read: /tmp/x");
    expect(extractCommand("Stat", { path: "/tmp/y" })).toBe("Stat: /tmp/y");
  });
  it("returns undefined when nothing usable is present", () => {
    expect(extractCommand("Bash", undefined)).toBeUndefined();
    expect(extractCommand("Bash", {})).toBeUndefined();
  });
});

describe("hook handlers dispatch to the client", () => {
  beforeEach(() => resetClient());
  afterEach(() => {
    resetClient();
    vi.restoreAllMocks();
  });

  const spyLock = () =>
    vi.spyOn(PulseClient.prototype, "lock").mockResolvedValue({} as never);
  const spyUnlock = () =>
    vi.spyOn(PulseClient.prototype, "unlock").mockResolvedValue({} as never);

  it("PreToolUse locks a per-tool service with command + family", async () => {
    const lockSpy = spyLock();
    await handlePreToolUse({ session_id: "s1", tool_name: "Bash", tool_input: { command: "ls -la" } });
    const [service, opts] = lockSpy.mock.calls[0];
    expect(service).toBe("claude-code/Bash");
    expect(opts?.tool_name).toBe("Bash");
    expect(opts?.command).toBe("ls -la");
    expect(opts?.command_family).toBe("shell");
  });

  it("PostToolUse unlocks with the exit code and a failure message", async () => {
    const unlockSpy = spyUnlock();
    await handlePostToolUse({ session_id: "s1", tool_name: "Bash", exit_code: 1 });
    const [service, opts] = unlockSpy.mock.calls[0];
    expect(service).toBe("claude-code/Bash");
    expect(opts?.exit_code).toBe(1);
    expect(String(opts?.message)).toMatch(/failed/i);
  });

  it("SessionStart/End lock and unlock the session service", async () => {
    const lockSpy = spyLock();
    const unlockSpy = spyUnlock();
    await handleSessionStart({ session_id: "s1" });
    expect(lockSpy.mock.calls[0][0]).toBe("claude-code/session");

    await handleSessionEnd({ session_id: "s1" });
    const [service, opts] = unlockSpy.mock.calls[0];
    expect(service).toBe("claude-code/session");
    expect(opts?.exit_code).toBe(0);
  });
});
