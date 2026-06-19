import { describe, it, expect, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { createDatabase } from "./db.js";
import { startMonitor } from "./monitor.js";
import type { PulseConfig } from "../core/models.js";

const tempFiles: string[] = [];
function tempDbPath(): string {
  const p = join(
    tmpdir(),
    `agent-heart-mon-${process.pid}-${tempFiles.length}-${Math.floor(performance.now() * 1000)}.db`,
  );
  tempFiles.push(p);
  return p;
}
const agoIso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

function makeConfig(): PulseConfig {
  return {
    server: { host: "127.0.0.1", port: 0 },
    // Large interval so the timer never fires during the test — we rely on the
    // initial synchronous check() that startMonitor runs immediately.
    monitor: {
      check_interval_ms: 1_000_000,
      default_expected_cycle_ms: 1000,
      default_max_silence_ms: 5000,
    },
    services: [],
    database: { path: ":memory:" },
    redact: { enabled: true, patterns: [] },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempFiles.length) {
    const p = tempFiles.pop()!;
    if (existsSync(p)) rmSync(p, { force: true });
  }
});

describe("startMonitor initial check", () => {
  it("marks a lagging run stale and a long-silent run dead", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {}); // silence monitor logs
    const db = await createDatabase(tempDbPath());

    const lagging = db.createRun({ service_name: "svc", action: "lock" });
    db.updateRun(lagging.run_id, { last_heartbeat: agoIso(2000) }); // > 1s, < 5s

    const silent = db.createRun({ service_name: "svc", action: "lock" });
    db.updateRun(silent.run_id, { last_heartbeat: agoIso(10_000) }); // > 5s

    // startMonitor runs check() synchronously before returning the stop fn.
    const stop = startMonitor(db, makeConfig());
    stop();

    expect(db.getRun(lagging.run_id)?.status).toBe("stale");
    expect(db.getRun(silent.run_id)?.status).toBe("dead");
    db.close();
  });

  it("leaves a freshly-beating run untouched", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = await createDatabase(tempDbPath());
    const fresh = db.createRun({ service_name: "svc", action: "lock" });

    const stop = startMonitor(db, makeConfig());
    stop();

    expect(db.getRun(fresh.run_id)?.status).toBe("locked");
    db.close();
  });
});
