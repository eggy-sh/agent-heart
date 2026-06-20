import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import {
  loadConfig,
  getServerUrl,
  resolveDbPath,
  DEFAULT_CONFIG,
} from "./config.js";
import type { PulseConfig } from "./models.js";

const tempFiles: string[] = [];
function tempCfg(contents: string): string {
  const p = join(
    tmpdir(),
    `agent-heart-cfg-${process.pid}-${tempFiles.length}-${Math.floor(performance.now() * 1000)}.json`,
  );
  writeFileSync(p, contents);
  tempFiles.push(p);
  return p;
}

afterEach(() => {
  while (tempFiles.length) {
    const p = tempFiles.pop()!;
    if (existsSync(p)) rmSync(p, { force: true });
  }
});

describe("loadConfig", () => {
  it("returns defaults when the file does not exist", () => {
    const cfg = loadConfig(join(tmpdir(), "definitely-not-here-12345.json"));
    expect(cfg.server.port).toBe(DEFAULT_CONFIG.server.port);
    expect(cfg.monitor.check_interval_ms).toBe(DEFAULT_CONFIG.monitor.check_interval_ms);
    expect(cfg.redact.enabled).toBe(true);
  });

  it("deep-merges a partial config over the defaults", () => {
    const cfg = loadConfig(tempCfg(JSON.stringify({ server: { port: 9999 } })));
    expect(cfg.server.port).toBe(9999); // overridden
    expect(cfg.server.host).toBe(DEFAULT_CONFIG.server.host); // kept from defaults
    expect(cfg.monitor.check_interval_ms).toBe(DEFAULT_CONFIG.monitor.check_interval_ms);
  });

  it("passes configured services through", () => {
    const cfg = loadConfig(
      tempCfg(
        JSON.stringify({
          services: [{ name: "claude", expected_cycle_ms: 1, max_silence_ms: 2 }],
        }),
      ),
    );
    expect(cfg.services).toHaveLength(1);
    expect(cfg.services[0].name).toBe("claude");
  });

  it("falls back to defaults on malformed JSON", () => {
    const cfg = loadConfig(tempCfg("{ this is not json"));
    expect(cfg.server.port).toBe(DEFAULT_CONFIG.server.port);
  });
});

describe("getServerUrl", () => {
  it("builds the URL from the config's host and port", () => {
    const cfg: PulseConfig = {
      ...DEFAULT_CONFIG,
      server: { host: "1.2.3.4", port: 1234 },
    };
    expect(getServerUrl(cfg)).toBe("http://1.2.3.4:1234");
  });
});

describe("resolveDbPath", () => {
  it("returns absolute paths unchanged", () => {
    const cfg: PulseConfig = {
      ...DEFAULT_CONFIG,
      database: { path: "/var/lib/agent-heart/pulse.db" },
    };
    expect(resolveDbPath(cfg)).toBe("/var/lib/agent-heart/pulse.db");
  });

  it("resolves a relative path to an absolute one", () => {
    const cfg: PulseConfig = {
      ...DEFAULT_CONFIG,
      database: { path: "relative.db" },
    };
    const resolved = resolveDbPath(cfg);
    expect(isAbsolute(resolved)).toBe(true);
    expect(resolved.endsWith("relative.db")).toBe(true);
  });
});
