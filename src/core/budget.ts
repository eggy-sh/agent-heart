import type { BudgetEval, BudgetMetric, Severity } from "./models.js";

const SEVERITY_RANK: Record<Severity, number> = {
  ok: 0,
  warning: 1,
  critical: 2,
};

function worse(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/**
 * Evaluate one metric (tokens or cost) against an optional limit.
 *
 * A non-positive or undefined limit is treated as "unset" (no budget), which
 * avoids divide-by-zero and means an unconfigured budget never raises an alarm.
 * ≥100% of the limit is critical (over budget), ≥80% is a warning.
 */
function evaluateMetric(used: number, limit?: number): BudgetMetric {
  if (!limit || limit <= 0) {
    return { used, limit: null, pct: null, severity: "ok" };
  }
  const pct = Math.round((used / limit) * 100);
  let severity: Severity = "ok";
  if (pct >= 100) severity = "critical";
  else if (pct >= 80) severity = "warning";
  return { used, limit, pct, severity };
}

/** Evaluate token + cost usage against optional per-metric limits. */
export function evaluateBudget(
  used: { tokens: number; cost_usd: number },
  limit: { tokens?: number; cost_usd?: number },
): BudgetEval {
  const tokens = evaluateMetric(used.tokens, limit.tokens);
  const cost_usd = evaluateMetric(used.cost_usd, limit.cost_usd);
  return {
    tokens,
    cost_usd,
    severity: worse(tokens.severity, cost_usd.severity),
  };
}

/** True when usage has reached or exceeded a configured limit. */
export function isOverBudget(evaluated: BudgetEval): boolean {
  return evaluated.severity === "critical";
}
