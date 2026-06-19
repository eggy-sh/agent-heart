import chalk from "chalk";
import { severityRank, type RunTreeNode } from "../core/tree.js";
import { formatStatus, formatDuration } from "../utils/logger.js";
import type { Run, Severity } from "../core/models.js";

function shortId(id: string, len = 8): string {
  return id.length > len ? id.slice(0, len) : id;
}

function nodeDuration(run: Run): string {
  if (run.duration_ms !== null) return formatDuration(run.duration_ms);
  if (
    run.status === "active" ||
    run.status === "locked" ||
    run.status === "stale"
  ) {
    return formatDuration(Date.now() - new Date(run.started_at).getTime());
  }
  return chalk.dim("-");
}

function subtreeAnnotation(node: RunTreeNode): string {
  // Only flag when a descendant is worse than the node's own state, so a stuck
  // or dead leaf is visible from a healthy-looking root.
  if (
    node.children.length === 0 ||
    severityRank(node.subtreeSeverity) <= severityRank(node.run.severity)
  ) {
    return "";
  }
  const color =
    node.subtreeSeverity === "critical" ? chalk.red : chalk.yellow;
  return " " + color(`⚠ subtree ${node.subtreeSeverity}`);
}

function label(node: RunTreeNode): string {
  const run = node.run;
  const tool = run.tool_name ? chalk.cyan(run.tool_name) : chalk.dim("-");
  const count =
    node.descendantCount > 0
      ? chalk.dim(` (${node.descendantCount} sub)`)
      : "";
  return (
    `${chalk.white(shortId(run.run_id))}  ` +
    `${chalk.white(run.service_name)}  ` +
    `${tool}  ` +
    `${formatStatus(run.status)}  ` +
    `${chalk.dim(nodeDuration(run))}` +
    count +
    subtreeAnnotation(node)
  );
}

/** Render a forest of run trees into printable lines using box-drawing glyphs. */
export function renderForest(forest: RunTreeNode[]): string[] {
  const lines: string[] = [];

  function walk(
    node: RunTreeNode,
    prefix: string,
    isRoot: boolean,
    isLast: boolean,
  ): void {
    if (isRoot) {
      lines.push(label(node));
    } else {
      lines.push(prefix + (isLast ? "└─ " : "├─ ") + label(node));
    }
    const childPrefix = isRoot ? "" : prefix + (isLast ? "   " : "│  ");
    node.children.forEach((child, i) =>
      walk(child, childPrefix, false, i === node.children.length - 1),
    );
  }

  forest.forEach((root) => walk(root, "", true, true));
  return lines;
}

interface ForestJsonNode {
  run_id: string;
  service_name: string;
  tool_name: string | null;
  status: string;
  severity: Severity;
  subtree_severity: Severity;
  descendant_count: number;
  duration_ms: number | null;
  children: ForestJsonNode[];
}

/** Serialize a forest into a nested JSON structure for --json output. */
export function forestToJson(forest: RunTreeNode[]): ForestJsonNode[] {
  return forest.map((node) => ({
    run_id: node.run.run_id,
    service_name: node.run.service_name,
    tool_name: node.run.tool_name,
    status: node.run.status,
    severity: node.run.severity,
    subtree_severity: node.subtreeSeverity,
    descendant_count: node.descendantCount,
    duration_ms: node.run.duration_ms,
    children: forestToJson(node.children),
  }));
}
