/**
 * Claude Code Hook Handler
 *
 * Maps Claude Code lifecycle events (SessionStart, PreToolUse, PostToolUse, SessionEnd)
 * to agent-heart lifecycle events (lock, beat, unlock).
 *
 * Usage from a Claude Code hook:
 *   echo '$TOOL_INPUT' | npx agent-heart hook claude-code --event pre-tool-use
 *
 * Or programmatically:
 *   import { handlePreToolUse } from "agent-heart/hooks/claude-code";
 *   await handlePreToolUse(data);
 */

import { PulseClient } from "../core/client.js";
import { redactCommand, redactMetadata } from "../utils/redact.js";

// --- Types for Claude Code hook payloads ---

export interface ClaudeCodeSessionEvent {
  session_id?: string;
  cwd?: string;
  model?: string;
  [key: string]: unknown;
}

export interface ClaudeCodeToolEvent {
  session_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: string;
  exit_code?: number;
  duration_ms?: number;
  [key: string]: unknown;
}

export type ClaudeCodeHookEvent = ClaudeCodeSessionEvent | ClaudeCodeToolEvent;

// --- Constants ---

const SERVICE_PREFIX = "claude-code";
const SESSION_SERVICE = `${SERVICE_PREFIX}/session`;

// Sensitive keys to strip from tool_input before storing
const SENSITIVE_INPUT_KEYS = new Set([
  "content",
  "file_content",
  "new_content",
  "body",
  "message",
]);

// Maximum length for stored command/input summaries
const MAX_INPUT_SUMMARY_LENGTH = 500;

// --- Helpers ---

/**
 * Build a service name from the tool name.
 * Example: "Bash" -> "claude-code/Bash"
 */
function toolServiceName(toolName: string): string {
  return `${SERVICE_PREFIX}/${toolName}`;
}

/**
 * Summarize tool input for storage. Strips sensitive keys,
 * truncates long values, and redacts secrets.
 */
function summarizeToolInput(
  toolInput: Record<string, unknown> | undefined,
): string {
  if (!toolInput || Object.keys(toolInput).length === 0) {
    return "";
  }

  const safe: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(toolInput)) {
    // Skip keys that commonly contain large or sensitive content
    if (SENSITIVE_INPUT_KEYS.has(key)) {
      safe[key] = "[OMITTED]";
      continue;
    }

    // Truncate long string values
    if (typeof value === "string" && value.length > 200) {
      safe[key] = value.slice(0, 200) + "...";
    } else {
      safe[key] = value;
    }
  }

  const summary = JSON.stringify(safe);

  // Apply redaction to the serialized summary
  const redacted = redactCommand(summary);

  // Truncate the final summary
  if (redacted.length > MAX_INPUT_SUMMARY_LENGTH) {
    return redacted.slice(0, MAX_INPUT_SUMMARY_LENGTH) + "...";
  }

  return redacted;
}

/**
 * Extract a command string from tool input.
 * For Bash tools, this is the command. For file tools, this is the file path.
 */
function extractCommand(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
): string | undefined {
  if (!toolInput) return undefined;

  // Bash-like tools: use the "command" field
  if (toolInput.command && typeof toolInput.command === "string") {
    return redactCommand(toolInput.command);
  }

  // File tools: use "file_path" or "path"
  if (toolInput.file_path && typeof toolInput.file_path === "string") {
    return `${toolName}: ${toolInput.file_path}`;
  }
  if (toolInput.path && typeof toolInput.path === "string") {
    return `${toolName}: ${toolInput.path}`;
  }

  return undefined;
}

/**
 * Determine the command family from the tool name.
 */
function commandFamily(toolName: string): string {
  const lower = toolName.toLowerCase();
  if (lower === "bash") return "shell";
  if (["read", "write", "edit", "glob", "grep"].includes(lower))
    return "filesystem";
  if (lower.startsWith("mcp__")) return "mcp";
  return "tool";
}

/**
 * Build metadata from a Claude Code event, redacting sensitive values.
 */
function buildMetadata(
  data: ClaudeCodeHookEvent,
  extra: Record<string, string> = {},
): Record<string, string> {
  const meta: Record<string, string> = { ...extra };

  if (data.cwd && typeof data.cwd === "string") {
    meta.cwd = data.cwd;
  }
  if (data.model && typeof data.model === "string") {
    meta.model = data.model;
  }

  return redactMetadata(meta);
}

// --- Client factory ---

let _clientInstance: PulseClient | null = null;

function getClient(sessionId?: string): PulseClient {
  if (!_clientInstance) {
    _clientInstance = new PulseClient({
      sessionId: sessionId ?? undefined,
    });
  }
  return _clientInstance;
}

/**
 * Reset the client instance. Useful for testing.
 */
export function resetClient(): void {
  _clientInstance = null;
}

// --- Hook Handlers ---

/**
 * Handle SessionStart hook.
 * Creates a lock on the session-level service.
 */
export async function handleSessionStart(
  data: ClaudeCodeSessionEvent,
): Promise<void> {
  const client = getClient(data.session_id);

  await client.lock(SESSION_SERVICE, {
    session_id: data.session_id,
    tool_name: "session",
    command_family: "session",
    message: "Claude Code session started",
    metadata: buildMetadata(data, { event: "session_start" }),
  });
}

/**
 * Handle PreToolUse hook.
 * Creates a lock for the specific tool call.
 */
export async function handlePreToolUse(
  data: ClaudeCodeToolEvent,
): Promise<void> {
  const toolName = data.tool_name ?? "unknown";
  const client = getClient(data.session_id);
  const toolInput = data.tool_input as
    | Record<string, unknown>
    | undefined;

  const command = extractCommand(toolName, toolInput);
  const inputSummary = summarizeToolInput(toolInput);

  await client.lock(toolServiceName(toolName), {
    session_id: data.session_id,
    tool_name: toolName,
    command: command,
    command_family: commandFamily(toolName),
    message: inputSummary || `Tool call: ${toolName}`,
    metadata: buildMetadata(data, { event: "pre_tool_use" }),
  });
}

/**
 * Handle PostToolUse hook.
 * Sends an unlock for the specific tool call with result metadata.
 */
export async function handlePostToolUse(
  data: ClaudeCodeToolEvent,
): Promise<void> {
  const toolName = data.tool_name ?? "unknown";
  const client = getClient(data.session_id);

  const exitCode =
    typeof data.exit_code === "number" ? data.exit_code : 0;
  const durationMs =
    typeof data.duration_ms === "number" ? data.duration_ms : undefined;

  const message =
    exitCode === 0
      ? `Tool call completed: ${toolName}`
      : `Tool call failed: ${toolName} (exit code ${exitCode})`;

  await client.unlock(toolServiceName(toolName), {
    session_id: data.session_id,
    tool_name: toolName,
    command_family: commandFamily(toolName),
    exit_code: exitCode,
    message,
    metadata: buildMetadata(data, {
      event: "post_tool_use",
      ...(durationMs !== undefined
        ? { duration_ms: String(durationMs) }
        : {}),
    }),
  });
}

/**
 * Handle SessionEnd hook.
 * Sends an unlock for the session-level service.
 */
export async function handleSessionEnd(
  data: ClaudeCodeSessionEvent,
): Promise<void> {
  const client = getClient(data.session_id);

  await client.unlock(SESSION_SERVICE, {
    session_id: data.session_id,
    tool_name: "session",
    command_family: "session",
    exit_code: 0,
    message: "Claude Code session ended",
    metadata: buildMetadata(data, { event: "session_end" }),
  });
}

// --- Stdin Parser ---

/**
 * Read JSON from stdin. Used when this module is invoked as a hook script.
 */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];

  return new Promise((resolve, reject) => {
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () =>
      resolve(Buffer.concat(chunks).toString("utf-8")),
    );
    process.stdin.on("error", reject);

    // If stdin is a TTY (no piped data), resolve empty after a short timeout
    if (process.stdin.isTTY) {
      resolve("{}");
    }
  });
}

/**
 * Main entry point for the hook CLI command.
 * Reads JSON from stdin and dispatches to the appropriate handler.
 */
export async function handleHookEvent(event: string): Promise<void> {
  const raw = await readStdin();
  let data: ClaudeCodeHookEvent;

  try {
    data = JSON.parse(raw || "{}") as ClaudeCodeHookEvent;
  } catch {
    // If stdin is not valid JSON, use empty object
    data = {};
  }

  switch (event) {
    case "session-start":
      await handleSessionStart(data as ClaudeCodeSessionEvent);
      break;
    case "pre-tool-use":
      await handlePreToolUse(data as ClaudeCodeToolEvent);
      break;
    case "post-tool-use":
      await handlePostToolUse(data as ClaudeCodeToolEvent);
      break;
    case "session-end":
      await handleSessionEnd(data as ClaudeCodeSessionEvent);
      break;
    default:
      throw new Error(`Unknown Claude Code hook event: ${event}`);
  }
}
