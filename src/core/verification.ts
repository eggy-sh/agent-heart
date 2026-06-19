import type { Run, VerificationSummary } from "./models.js";

/**
 * Count how many runs are awaiting verification, verified, or rejected.
 * Runs that never opted into verification (`verification === null`) are ignored.
 */
export function summarizeVerification(runs: Run[]): VerificationSummary {
  const summary: VerificationSummary = { pending: 0, passed: 0, failed: 0 };
  for (const r of runs) {
    if (r.verification === "pending") summary.pending++;
    else if (r.verification === "passed") summary.passed++;
    else if (r.verification === "failed") summary.failed++;
  }
  return summary;
}
