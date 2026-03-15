import type { PulseDB } from "./db.js";
import type { PulseConfig } from "../core/models.js";
import { log } from "../utils/logger.js";

export function startMonitor(db: PulseDB, config: PulseConfig): () => void {
  const {
    check_interval_ms,
    default_expected_cycle_ms,
    default_max_silence_ms,
  } = config.monitor;

  log.info(
    `Monitor started (interval=${check_interval_ms}ms, ` +
      `stale=${default_expected_cycle_ms}ms, dead=${default_max_silence_ms}ms)`,
  );

  // Seed configured services into the database
  for (const svc of config.services) {
    db.upsertService(svc);
  }

  // Track last-seen consecutive failure counts to only log on change
  const lastFailureCounts = new Map<string, number>();

  function check(): void {
    try {
      // Detect and mark stale runs
      const staleRuns = db.getStaleRuns(default_expected_cycle_ms);
      for (const run of staleRuns) {
        log.warn(
          `Run ${run.run_id} (${run.service_name}) marked stale — ` +
            `no heartbeat since ${run.last_heartbeat}`,
        );
        db.markStale(run.run_id);
      }

      // Detect and mark dead runs
      const deadRuns = db.getDeadRuns(default_max_silence_ms);
      for (const run of deadRuns) {
        log.error(
          `Run ${run.run_id} (${run.service_name}) marked dead — ` +
            `silent since ${run.last_heartbeat}`,
        );
        db.markDead(run.run_id);
      }

      // Detect consecutive failure loops
      const serviceStates = db.getServiceStates();
      for (const svc of serviceStates) {
        const failures = svc.consecutive_failures ?? 0;
        const prev = lastFailureCounts.get(svc.service_name) ?? 0;
        if (failures >= 3 && failures !== prev) {
          log.warn(
            `${svc.service_name}: ${failures} consecutive failures — possible agent loop`,
          );
        }
        lastFailureCounts.set(svc.service_name, failures);
      }
    } catch (err) {
      log.error(
        `Monitor check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Run an initial check immediately
  check();

  const intervalId = setInterval(check, check_interval_ms);

  // Return cleanup function
  return () => {
    clearInterval(intervalId);
    log.info("Monitor stopped");
  };
}
