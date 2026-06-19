import type { Run, RunStatus, Severity } from "./models.js";

/**
 * A run plus its descendants, with a rolled-up health summary.
 *
 * `subtreeSeverity` is the worst severity found anywhere in the subtree
 * (including the node itself), so an orchestrator root surfaces a stuck or
 * dead leaf without the reader having to expand every branch.
 */
export interface RunTreeNode {
  run: Run;
  children: RunTreeNode[];
  subtreeSeverity: Severity;
  descendantCount: number;
}

const SEVERITY_RANK: Record<Severity, number> = {
  ok: 0,
  warning: 1,
  critical: 2,
};

export function severityRank(s: Severity): number {
  return SEVERITY_RANK[s] ?? 0;
}

/** A run's status implies a floor severity even if its stored severity lags. */
function statusToSeverity(status: RunStatus): Severity {
  if (status === "dead") return "critical";
  if (status === "stale") return "warning";
  return "ok";
}

function ownSeverity(run: Run): Severity {
  const fromStatus = statusToSeverity(run.status);
  return severityRank(run.severity) >= severityRank(fromStatus)
    ? run.severity
    : fromStatus;
}

function worse(a: Severity, b: Severity): Severity {
  return severityRank(a) >= severityRank(b) ? a : b;
}

/**
 * Build a forest of run trees from a flat list.
 *
 * - A run whose `parent_run_id` is null, or points to a run not present in the
 *   list, becomes a root (orphan-safe — sub-runs render even if the parent was
 *   pruned or lives on another page).
 * - Children are ordered by `started_at`.
 * - Parent/child cycles are broken: every run still appears exactly once.
 */
export function buildRunForest(runs: Run[]): RunTreeNode[] {
  const byId = new Map<string, Run>();
  for (const r of runs) byId.set(r.run_id, r);

  const childIds = new Map<string, string[]>();
  const rootIds: string[] = [];

  for (const r of runs) {
    const parent = r.parent_run_id;
    if (parent && parent !== r.run_id && byId.has(parent)) {
      const siblings = childIds.get(parent);
      if (siblings) siblings.push(r.run_id);
      else childIds.set(parent, [r.run_id]);
    } else {
      rootIds.push(r.run_id);
    }
  }

  const visited = new Set<string>();

  function buildNode(id: string): RunTreeNode {
    visited.add(id);
    const run = byId.get(id)!;

    const children = (childIds.get(id) ?? [])
      .filter((cid) => !visited.has(cid))
      .map((cid) => byId.get(cid)!)
      .sort((a, b) => a.started_at.localeCompare(b.started_at))
      .map((child) => buildNode(child.run_id));

    let subtreeSeverity = ownSeverity(run);
    let descendantCount = 0;
    for (const child of children) {
      descendantCount += 1 + child.descendantCount;
      subtreeSeverity = worse(subtreeSeverity, child.subtreeSeverity);
    }

    return { run, children, subtreeSeverity, descendantCount };
  }

  const forest = rootIds
    .map((id) => byId.get(id)!)
    .sort((a, b) => a.started_at.localeCompare(b.started_at))
    .map((r) => buildNode(r.run_id));

  // Any run not reached above belongs to a parent/child cycle — surface it as
  // a root so nothing silently disappears.
  for (const r of runs) {
    if (!visited.has(r.run_id)) {
      forest.push(buildNode(r.run_id));
    }
  }

  return forest;
}

/**
 * Keep only the root trees whose subtree contains a run matching `predicate`.
 *
 * Whole matching subtrees are preserved, so filtering selects *which trees to
 * show* without ever severing a parent→child edge. This is why tree views must
 * build the forest from the full run set and prune here, rather than filtering
 * runs up front (which would drop differently-named children or hide the very
 * stale/dead leaves the subtree rollup is meant to surface).
 */
export function filterForest(
  forest: RunTreeNode[],
  predicate: (run: Run) => boolean,
): RunTreeNode[] {
  const matches = (node: RunTreeNode): boolean =>
    predicate(node.run) || node.children.some(matches);
  return forest.filter(matches);
}
