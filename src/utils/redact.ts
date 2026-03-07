import { loadConfig } from "../core/config.js";

export function redactCommand(command: string): string {
  const config = loadConfig();
  if (!config.redact.enabled) return command;

  let redacted = command;
  for (const pattern of config.redact.patterns) {
    // Redact --key=value and --key value patterns
    const flagRegex = new RegExp(
      `(--?${pattern}[=\\s]+)(\\S+)`,
      "gi",
    );
    redacted = redacted.replace(flagRegex, "$1[REDACTED]");

    // Redact environment variable-style KEY=value
    const envRegex = new RegExp(
      `(${pattern}[=])([^\\s]+)`,
      "gi",
    );
    redacted = redacted.replace(envRegex, "$1[REDACTED]");
  }

  return redacted;
}

export function redactMetadata(
  metadata: Record<string, string>,
): Record<string, string> {
  const config = loadConfig();
  if (!config.redact.enabled) return metadata;

  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    const isSensitive = config.redact.patterns.some((p) =>
      key.toLowerCase().includes(p.toLowerCase()),
    );
    redacted[key] = isSensitive ? "[REDACTED]" : value;
  }
  return redacted;
}
