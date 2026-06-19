/**
 * Harness-agnostic parent-run propagation.
 *
 * A single environment variable carries the "current run" across process
 * boundaries. Because every shell and agent harness propagates its environment
 * to child processes, wrapping work in `agent-heart exec` automatically makes
 * any nested `agent-heart` call a child of that run — no run-id threading and
 * nothing specific to Claude Code or any other harness.
 */
export const PARENT_RUN_ID_ENV = "AGENT_HEART_RUN_ID";

/**
 * Resolve the parent run id for a new run.
 * Precedence: an explicit value (e.g. a `--parent` flag) wins, otherwise the
 * inherited `AGENT_HEART_RUN_ID`. Blank values are treated as absent.
 */
export function resolveParentRunId(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const candidate = explicit ?? env[PARENT_RUN_ID_ENV];
  const trimmed = candidate?.trim();
  return trimmed ? trimmed : undefined;
}
