/**
 * OpenClaw Plugin Hook Handler
 *
 * Maps OpenClaw plugin hook events (before_tool_call, after_tool_call)
 * to agent-heart lifecycle events (lock, unlock).
 *
 * OpenClaw sends structured JSON events to plugin hooks via stdin.
 * The exec tool is the primary target for tracking, but other tool
 * types (browser, memory, etc.) are handled gracefully.
 *
 * Usage from an OpenClaw plugin hook:
 *   npx agent-heart hook openclaw < event.json
 *
 * Or programmatically:
 *   import { handleOpenClawEvent } from "agent-heart/hooks/openclaw";
 *   await handleOpenClawEvent(data);
 */

import { PulseClient } from "../core/client.js";
import { redactCommand, redactMetadata } from "../utils/redact.js";

// --- Types for OpenClaw hook payloads ---

export interface OpenClawExecParams {
  command?: string;
  workdir?: string;
  background?: boolean;
  timeout?: number;
  [key: string]: unknown;
}

export interface OpenClawToolResult {
  output?: string;
  exitCode?: number;
  duration?: number;
  error?: string;
  [key: string]: unknown;
}

export interface OpenClawSession {
  id?: string;
  agent?: string;
  [key: string]: unknown;
}

export interface OpenClawHookEvent {
  event?: string;
  tool?: string;
  params?: OpenClawExecParams | Record<string, unknown>;
  result?: OpenClawToolResult;
  session?: OpenClawSession;
  [key: string]: unknown;
}

// --- Constants ---

const SERVICE_PREFIX = "openclaw";

/**
 * Maps CLI binary names to human-readable command families.
 * Used to generate service names like "openclaw/github".
 */
const COMMAND_FAMILY_MAP: Record<string, string> = {
  gh: "github",
  git: "git",
  gws: "google-workspace",
  kubectl: "kubernetes",
  helm: "kubernetes",
  docker: "docker",
  "docker-compose": "docker",
  podman: "docker",
  curl: "http",
  wget: "http",
  httpie: "http",
  aws: "aws",
  gcloud: "gcp",
  az: "azure",
  terraform: "terraform",
  tf: "terraform",
  ansible: "ansible",
  npm: "npm",
  yarn: "npm",
  pnpm: "npm",
  bun: "npm",
  pip: "python",
  python: "python",
  python3: "python",
  node: "node",
  deno: "node",
  psql: "database",
  mysql: "database",
  mongosh: "database",
  redis: "database",
  ssh: "ssh",
  scp: "ssh",
  rsync: "ssh",
  make: "build",
  cmake: "build",
  cargo: "build",
  go: "build",
  mvn: "build",
  gradle: "build",
};

/** Tool types that represent exec/shell commands worth tracking in detail. */
const EXEC_TOOL_TYPES = new Set(["exec", "shell", "terminal", "command"]);

/** Maximum length for stored command summaries. */
const MAX_COMMAND_LENGTH = 500;

// --- Helpers ---

/**
 * Extract the first token (binary name) from a shell command string.
 */
function extractBinaryName(command: string): string {
  const trimmed = command.trim();

  // Handle env prefix: env VAR=val command ...
  if (trimmed.startsWith("env ")) {
    const parts = trimmed.split(/\s+/);
    for (let i = 1; i < parts.length; i++) {
      if (!parts[i].includes("=")) {
        return parts[i];
      }
    }
  }

  // Handle sudo prefix
  if (trimmed.startsWith("sudo ")) {
    const parts = trimmed.split(/\s+/);
    // Skip sudo flags like -u, -E, etc.
    for (let i = 1; i < parts.length; i++) {
      if (!parts[i].startsWith("-")) {
        return parts[i];
      }
    }
  }

  // Standard case: first token
  const firstToken = trimmed.split(/\s+/)[0];
  // Strip path prefix (e.g., /usr/bin/gh -> gh)
  return firstToken.split("/").pop() ?? firstToken;
}

/**
 * Determine the command family from a binary name.
 * Falls back to the binary name itself if not in the mapping.
 */
function resolveCommandFamily(binary: string): string {
  const lower = binary.toLowerCase();
  return COMMAND_FAMILY_MAP[lower] ?? lower;
}

/**
 * Build a service name from the command family.
 * Example: "github" -> "openclaw/github"
 */
function buildServiceName(commandFamily: string): string {
  return `${SERVICE_PREFIX}/${commandFamily}`;
}

/**
 * Parse a command string to extract the tool name and, where possible,
 * the resource kind (the first subcommand or object noun).
 *
 * Examples:
 *   "gh pr list --repo foo" -> { tool: "gh", resource: "pulls" }
 *   "kubectl get pods -n prod" -> { tool: "kubectl", resource: "pods" }
 *   "curl https://example.com" -> { tool: "curl", resource: "http" }
 */
function parseCommand(command: string): {
  tool: string;
  resource: string | undefined;
} {
  const binary = extractBinaryName(command);
  const parts = command.trim().split(/\s+/);

  // Find the index of the binary in the parts array
  let binaryIdx = parts.indexOf(binary);
  if (binaryIdx === -1) {
    // May have been extracted from a path
    binaryIdx = parts.findIndex((p) => p.endsWith(`/${binary}`));
  }

  const argsAfterBinary = parts.slice(binaryIdx + 1);

  // Special resource mappings for known CLIs
  const resource = extractResource(binary, argsAfterBinary);

  return { tool: binary, resource };
}

/**
 * Extract a resource kind from CLI arguments based on the binary.
 */
function extractResource(
  binary: string,
  args: string[],
): string | undefined {
  // Skip flags to find the first positional argument(s)
  const positional: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("-")) continue;
    positional.push(arg);
    if (positional.length >= 2) break;
  }

  if (positional.length === 0) return undefined;

  const lower = binary.toLowerCase();

  // gh <noun> <verb> pattern: "gh pr list" -> "pulls"
  if (lower === "gh") {
    const ghResourceMap: Record<string, string> = {
      pr: "pulls",
      issue: "issues",
      repo: "repos",
      release: "releases",
      run: "actions",
      workflow: "actions",
      gist: "gists",
      api: "api",
      auth: "auth",
      codespace: "codespaces",
      secret: "secrets",
      variable: "variables",
    };
    return ghResourceMap[positional[0]] ?? positional[0];
  }

  // kubectl <verb> <resource> pattern: "kubectl get pods" -> "pods"
  if (lower === "kubectl" || lower === "helm") {
    // The resource is usually the second positional (after the verb)
    return positional.length >= 2 ? positional[1] : positional[0];
  }

  // gws <service> <noun> <verb> pattern: "gws drive files list" -> "drive"
  if (lower === "gws") {
    return positional[0]; // drive, gmail, calendar, etc.
  }

  // docker <verb> <noun> pattern: "docker ps" or "docker build"
  if (lower === "docker" || lower === "podman") {
    const dockerResourceMap: Record<string, string> = {
      ps: "containers",
      run: "containers",
      exec: "containers",
      build: "images",
      pull: "images",
      push: "images",
      compose: "compose",
      volume: "volumes",
      network: "networks",
    };
    return dockerResourceMap[positional[0]] ?? positional[0];
  }

  // aws <service> <action> pattern: "aws s3 ls" -> "s3"
  if (lower === "aws") {
    return positional[0]; // s3, ec2, lambda, etc.
  }

  // gcloud <group> <command> pattern: "gcloud compute instances list" -> "compute"
  if (lower === "gcloud") {
    return positional[0];
  }

  // Generic: return the first positional arg if it looks like a subcommand
  if (positional[0] && !positional[0].includes("/") && !positional[0].includes(".")) {
    return positional[0];
  }

  return undefined;
}

/**
 * Truncate and redact a command string for storage.
 */
function sanitizeCommand(command: string): string {
  const redacted = redactCommand(command);
  if (redacted.length > MAX_COMMAND_LENGTH) {
    return redacted.slice(0, MAX_COMMAND_LENGTH) + "...";
  }
  return redacted;
}

/**
 * Build metadata from an OpenClaw event, redacting sensitive values.
 */
function buildMetadata(
  data: OpenClawHookEvent,
  extra: Record<string, string> = {},
): Record<string, string> {
  const meta: Record<string, string> = { ...extra };

  if (data.session?.agent) {
    meta.agent = data.session.agent;
  }

  const params = data.params as OpenClawExecParams | undefined;
  if (params?.workdir && typeof params.workdir === "string") {
    meta.workdir = params.workdir;
  }
  if (params?.background === true) {
    meta.background = "true";
  }
  if (params?.timeout !== undefined) {
    meta.timeout = String(params.timeout);
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
 * Handle before_tool_call for exec tools.
 * Sends a `lock` to agent-heart with command metadata.
 */
export async function handleBeforeToolCall(
  data: OpenClawHookEvent,
): Promise<void> {
  const tool = data.tool ?? "unknown";
  const sessionId = data.session?.id;
  const client = getClient(sessionId);

  // For non-exec tools, send a simple lock with tool type as service
  if (!EXEC_TOOL_TYPES.has(tool)) {
    const serviceName = `${SERVICE_PREFIX}/${tool}`;
    await client.lock(serviceName, {
      session_id: sessionId,
      tool_name: tool,
      command_family: tool,
      message: `OpenClaw ${tool} tool call started`,
      metadata: buildMetadata(data, { event: "before_tool_call" }),
    });
    return;
  }

  // Extract command details from exec params
  const params = data.params as OpenClawExecParams | undefined;
  const rawCommand = params?.command ?? "";
  const { tool: binaryName, resource } = parseCommand(rawCommand);
  const family = resolveCommandFamily(binaryName);
  const serviceName = buildServiceName(family);

  await client.lock(serviceName, {
    session_id: sessionId,
    tool_name: binaryName,
    command: rawCommand ? sanitizeCommand(rawCommand) : undefined,
    command_family: family,
    resource_kind: resource,
    message: rawCommand
      ? `exec: ${sanitizeCommand(rawCommand)}`
      : "exec: (empty command)",
    metadata: buildMetadata(data, { event: "before_tool_call" }),
  });
}

/**
 * Handle after_tool_call for exec tools.
 * Sends an `unlock` to agent-heart with exit code and duration.
 */
export async function handleAfterToolCall(
  data: OpenClawHookEvent,
): Promise<void> {
  const tool = data.tool ?? "unknown";
  const sessionId = data.session?.id;
  const client = getClient(sessionId);
  const result = data.result as OpenClawToolResult | undefined;
  const exitCode = result?.exitCode ?? 0;
  const duration = result?.duration;

  // For non-exec tools, send a simple unlock
  if (!EXEC_TOOL_TYPES.has(tool)) {
    const serviceName = `${SERVICE_PREFIX}/${tool}`;
    const message =
      exitCode === 0
        ? `OpenClaw ${tool} tool call completed`
        : `OpenClaw ${tool} tool call failed (exit code ${exitCode})`;

    await client.unlock(serviceName, {
      session_id: sessionId,
      tool_name: tool,
      command_family: tool,
      exit_code: exitCode,
      message,
      metadata: buildMetadata(data, {
        event: "after_tool_call",
        ...(duration !== undefined ? { duration_ms: String(duration) } : {}),
      }),
    });
    return;
  }

  // Extract command details from exec params
  const params = data.params as OpenClawExecParams | undefined;
  const rawCommand = params?.command ?? "";
  const { tool: binaryName, resource } = parseCommand(rawCommand);
  const family = resolveCommandFamily(binaryName);
  const serviceName = buildServiceName(family);

  const message =
    exitCode === 0
      ? `exec completed: ${binaryName}${resource ? ` (${resource})` : ""}`
      : `exec failed: ${binaryName}${resource ? ` (${resource})` : ""} (exit code ${exitCode})`;

  await client.unlock(serviceName, {
    session_id: sessionId,
    tool_name: binaryName,
    command: rawCommand ? sanitizeCommand(rawCommand) : undefined,
    command_family: family,
    resource_kind: resource,
    exit_code: exitCode,
    message,
    metadata: buildMetadata(data, {
      event: "after_tool_call",
      ...(duration !== undefined ? { duration_ms: String(duration) } : {}),
      ...(result?.error ? { error: result.error.slice(0, 200) } : {}),
    }),
  });
}

/**
 * Dispatch an OpenClaw hook event to the appropriate handler.
 *
 * Routes based on the `event` field in the incoming JSON:
 * - "before_tool_call" -> handleBeforeToolCall
 * - "after_tool_call" -> handleAfterToolCall
 *
 * Unknown events are logged and ignored.
 */
export async function handleOpenClawEvent(
  data: OpenClawHookEvent,
): Promise<void> {
  const event = data.event;

  switch (event) {
    case "before_tool_call":
      await handleBeforeToolCall(data);
      break;
    case "after_tool_call":
      await handleAfterToolCall(data);
      break;
    default:
      // Unknown or unsupported event type -- ignore gracefully
      if (event) {
        console.error(
          `[agent-heart] Ignoring unknown OpenClaw event: ${event}`,
        );
      } else {
        console.error(
          "[agent-heart] Received OpenClaw event with no 'event' field",
        );
      }
      break;
  }
}

// --- Stdin Parser ---

/**
 * Read JSON from stdin. Used when this module is invoked as a hook script.
 */
async function readStdin(): Promise<string> {
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
 * Main entry point for the OpenClaw hook CLI command.
 * Reads JSON from stdin and dispatches to the appropriate handler.
 *
 * Usage:
 *   echo '{"event":"before_tool_call",...}' | npx agent-heart hook openclaw
 */
export async function readStdinAndHandle(): Promise<void> {
  const raw = await readStdin();
  let data: OpenClawHookEvent;

  try {
    data = JSON.parse(raw || "{}") as OpenClawHookEvent;
  } catch {
    // If stdin is not valid JSON, use empty object
    console.error("[agent-heart] Failed to parse OpenClaw hook event JSON");
    data = {};
  }

  await handleOpenClawEvent(data);
}
