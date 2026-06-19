import { loadConfig } from "../core/config.js";

export interface RedactConfig {
  enabled: boolean;
  patterns: string[];
}

/** Use an explicit redaction config when given, otherwise load it from disk.
 *  The override hook keeps the redaction logic testable without global config. */
function resolveRedactConfig(override?: RedactConfig): RedactConfig {
  return override ?? loadConfig().redact;
}

export function redactCommand(command: string, override?: RedactConfig): string {
  const { enabled, patterns } = resolveRedactConfig(override);
  if (!enabled) return command;

  let redacted = command;
  for (const pattern of patterns) {
    // Redact --key=value and --key value patterns
    const flagRegex = new RegExp(`(--?${pattern}[=\\s]+)(\\S+)`, "gi");
    redacted = redacted.replace(flagRegex, "$1[REDACTED]");

    // Redact environment variable-style KEY=value
    const envRegex = new RegExp(`(${pattern}[=])([^\\s]+)`, "gi");
    redacted = redacted.replace(envRegex, "$1[REDACTED]");
  }

  return redacted;
}

export function redactMetadata(
  metadata: Record<string, string>,
  override?: RedactConfig,
): Record<string, string> {
  const { enabled, patterns } = resolveRedactConfig(override);
  if (!enabled) return metadata;

  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    const isSensitive = patterns.some((p) =>
      key.toLowerCase().includes(p.toLowerCase()),
    );
    redacted[key] = isSensitive ? "[REDACTED]" : value;
  }
  return redacted;
}
