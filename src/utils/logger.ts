import chalk from "chalk";

const PREFIX = chalk.bold.cyan("pulse");

/**
 * Logging helpers that separate human messages (stderr) from data (stdout).
 *
 * All human-facing messages (info, success, warn, error, dim) go to stderr
 * so they never pollute piped data output. Data output (json) goes to stdout.
 *
 * This means:
 *   npx agent-heart runs --json | jq .       # clean JSON, no chrome
 *   npx agent-heart exec --service x -- ls   # ls output on stdout, pulse messages on stderr
 *   npx agent-heart status 2>/dev/null        # just the table
 */
export const log = {
  info: (msg: string) => console.error(`${PREFIX} ${msg}`),
  success: (msg: string) => console.error(`${PREFIX} ${chalk.green("✓")} ${msg}`),
  warn: (msg: string) => console.error(`${PREFIX} ${chalk.yellow("⚠")} ${msg}`),
  error: (msg: string) => console.error(`${PREFIX} ${chalk.red("✗")} ${msg}`),
  dim: (msg: string) => console.error(`${PREFIX} ${chalk.dim(msg)}`),
  json: (data: unknown) => {
    const indent = process.stdout.isTTY ? 2 : 0;
    console.log(JSON.stringify(data, null, indent));
  },
};

/** Write chrome/decoration to stderr so it doesn't pollute piped output. */
export const chrome = {
  log: (msg: string) => process.stderr.write(msg + "\n"),
  blank: () => process.stderr.write("\n"),
};

export function formatStatus(status: string): string {
  switch (status) {
    case "locked":
    case "active":
      return chalk.blue(status);
    case "completed":
      return chalk.green(status);
    case "failed":
      return chalk.red(status);
    case "stale":
      return chalk.yellow(status);
    case "dead":
      return chalk.bgRed.white(` ${status} `);
    default:
      return status;
  }
}

export function formatSeverity(severity: string): string {
  switch (severity) {
    case "ok":
      return chalk.green(severity);
    case "warning":
      return chalk.yellow(severity);
    case "critical":
      return chalk.red(severity);
    default:
      return severity;
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString();
}
