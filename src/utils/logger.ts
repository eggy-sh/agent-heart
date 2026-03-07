import chalk from "chalk";

const PREFIX = chalk.bold.cyan("pulse");

export const log = {
  info: (msg: string) => console.log(`${PREFIX} ${msg}`),
  success: (msg: string) => console.log(`${PREFIX} ${chalk.green("✓")} ${msg}`),
  warn: (msg: string) => console.log(`${PREFIX} ${chalk.yellow("⚠")} ${msg}`),
  error: (msg: string) => console.error(`${PREFIX} ${chalk.red("✗")} ${msg}`),
  dim: (msg: string) => console.log(`${PREFIX} ${chalk.dim(msg)}`),
  json: (data: unknown) => console.log(JSON.stringify(data, null, 2)),
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
