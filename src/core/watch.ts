import type { Run, RunStatus } from "./models.js";

const TERMINAL: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "completed",
  "failed",
  "dead",
]);

export interface WatchVerdict {
  /** True when the watch should stop blocking. */
  resolved: boolean;
  /** Process exit code to use when resolved: 0 = clean, 1 = something unsuccessful. */
  exitCode: number;
  /** Human-readable explanation of why it resolved (or that it hasn't). */
  reason: string;
  /** Count of runs per status, for display. */
  counts: Record<string, number>;
}

function countByStatus(runs: Run[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of runs) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return counts;
}

/**
 * Decide whether a watched set of runs has resolved, and with what exit code.
 *
 * - With `until`, resolve as soon as any run is in one of those states; the exit
 *   code reflects whether the triggering runs completed cleanly (e.g. `--until
 *   dead` fires with exit 1, a death alarm).
 * - Without `until`, resolve once every run is terminal; exit 0 iff all completed.
 * - An empty set resolves immediately with exit 0 (nothing to wait on).
 */
export function evaluateWatch(
  runs: Run[],
  until: RunStatus[] | null,
): WatchVerdict {
  const counts = countByStatus(runs);

  if (runs.length === 0) {
    return { resolved: true, exitCode: 0, reason: "no matching runs", counts };
  }

  if (until && until.length > 0) {
    const triggered = runs.filter((r) => until.includes(r.status));
    if (triggered.length === 0) {
      return {
        resolved: false,
        exitCode: 0,
        reason: `waiting for a run to reach ${until.join("/")}`,
        counts,
      };
    }
    const allClean = triggered.every((r) => r.status === "completed");
    return {
      resolved: true,
      exitCode: allClean ? 0 : 1,
      reason: `${triggered.length} run(s) reached ${until.join("/")}`,
      counts,
    };
  }

  const allTerminal = runs.every((r) => TERMINAL.has(r.status));
  if (!allTerminal) {
    return {
      resolved: false,
      exitCode: 0,
      reason: "runs still in progress",
      counts,
    };
  }

  const allCompleted = runs.every((r) => r.status === "completed");
  return {
    resolved: true,
    exitCode: allCompleted ? 0 : 1,
    reason: allCompleted
      ? "all runs completed"
      : "all runs settled, some did not complete cleanly",
    counts,
  };
}
