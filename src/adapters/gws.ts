/**
 * GWS (Google Workspace CLI) Command Parser and Adapter
 *
 * Parses the consistent gws command structure:
 *   gws [service] [resource] [method] [flags]
 *
 * Examples:
 *   gws drive files list --params '{"pageSize": 10}'
 *   gws sheets spreadsheets create --body '{"properties":{"title":"Test"}}'
 *   gws chat spaces messages create --params '{"parent":"spaces/abc"}' --body '{"text":"Hello"}'
 *   gws admin directory users list
 */

// --- Interfaces ---

export interface GwsCommandInfo {
  service: string;
  resource: string;
  method: string;
  operationType: "read" | "write" | "delete" | "admin";
  isPaginated: boolean;
  isDryRun: boolean;
  fullCommand: string;
}

export interface GwsResultInfo {
  success: boolean;
  errorType: "auth" | "quota" | "not_found" | "server" | "client" | null;
  httpStatus: number | null;
  itemCount: number | null;
  hasNextPage: boolean;
}

// --- Constants ---

const READ_METHODS = new Set(["list", "get", "search", "query", "watch"]);
const WRITE_METHODS = new Set(["create", "update", "patch", "insert", "send", "import", "copy", "move"]);
const DELETE_METHODS = new Set(["delete", "remove", "trash", "purge"]);
const ADMIN_METHODS = new Set(["transfer", "archive", "suspend", "unsuspend", "makeAdmin", "assign", "revoke"]);

const KNOWN_SERVICES = new Set([
  "drive",
  "sheets",
  "docs",
  "slides",
  "chat",
  "calendar",
  "gmail",
  "admin",
  "vault",
  "meet",
  "groups",
  "classroom",
  "tasks",
  "people",
  "forms",
  "keep",
]);

// Flags that take a value (next arg is the value, not a positional)
const FLAGS_WITH_VALUE = new Set([
  "--params",
  "--body",
  "--fields",
  "--format",
  "--filter",
  "--order-by",
  "--page-size",
  "--project",
  "--account",
  "--impersonate",
]);

// --- Command Parser ---

/**
 * Parse a gws CLI invocation into structured metadata.
 *
 * Accepts the argument array that follows the `gws` binary name.
 * For example, if the full command is:
 *   gws drive files list --params '{"pageSize": 10}'
 * then `args` should be:
 *   ["drive", "files", "list", "--params", '{"pageSize": 10}']
 *
 * Returns null if the args don't look like a valid gws command.
 */
export function parseGwsCommand(args: string[]): GwsCommandInfo | null {
  if (args.length === 0) return null;

  // Strip leading "gws" if the caller included it
  const normalized = args[0] === "gws" ? args.slice(1) : [...args];

  // Extract positional tokens (skip flags and their values)
  const positionals: string[] = [];
  const flags = new Set<string>();
  let i = 0;

  while (i < normalized.length) {
    const token = normalized[i];

    if (token.startsWith("--")) {
      flags.add(token);

      // If this flag takes a value, skip the next token
      if (FLAGS_WITH_VALUE.has(token) && i + 1 < normalized.length) {
        i += 2;
        continue;
      }

      // Handle --flag=value form
      if (token.includes("=")) {
        i += 1;
        continue;
      }

      i += 1;
      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      // Short flag — skip it (and its potential value)
      i += 1;
      continue;
    }

    positionals.push(token);
    i += 1;
  }

  // We need at least service + resource + method (minimum 3 positionals)
  // But some commands have deeper nesting (e.g., admin directory users list = 4)
  if (positionals.length < 3) return null;

  // The first positional should be a known service (or we accept it anyway)
  const service = positionals[0];
  // The method is always the last positional
  const method = positionals[positionals.length - 1];
  // Everything between service and method forms the resource path
  const resource = positionals.slice(1, -1).join("/");

  const fullCommand = "gws " + args.join(" ");

  return {
    service,
    resource,
    method,
    operationType: classifyMethod(method),
    isPaginated: flags.has("--page-all"),
    isDryRun: flags.has("--dry-run"),
    fullCommand,
  };
}

function classifyMethod(method: string): GwsCommandInfo["operationType"] {
  if (READ_METHODS.has(method)) return "read";
  if (WRITE_METHODS.has(method)) return "write";
  if (DELETE_METHODS.has(method)) return "delete";
  if (ADMIN_METHODS.has(method)) return "admin";
  // Default to write for unknown methods — safer to assume side-effects
  return "write";
}

// --- Output Parser ---

/**
 * Parse the JSON stdout of a gws command to extract result metadata.
 *
 * gws typically outputs JSON. This function attempts to classify errors
 * and extract useful counts from the output.
 */
export function parseGwsOutput(stdout: string, exitCode: number): GwsResultInfo {
  const result: GwsResultInfo = {
    success: exitCode === 0,
    errorType: null,
    httpStatus: null,
    itemCount: null,
    hasNextPage: false,
  };

  if (!stdout.trim()) {
    // Empty output with a non-zero exit code is still a failure
    if (exitCode !== 0) {
      result.errorType = "client";
    }
    return result;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Not valid JSON — try to extract error info from raw text
    return classifyFromRawText(stdout, exitCode, result);
  }

  if (typeof parsed !== "object" || parsed === null) {
    return result;
  }

  const obj = parsed as Record<string, unknown>;

  // Extract HTTP status if present in error responses
  const httpStatus = extractHttpStatus(obj);
  if (httpStatus !== null) {
    result.httpStatus = httpStatus;
    result.errorType = classifyHttpStatus(httpStatus);
    if (result.errorType !== null) {
      result.success = false;
    }
  }

  // Check for error object (Google API style)
  if (obj.error) {
    result.success = false;
    const err = obj.error as Record<string, unknown>;
    const code = typeof err.code === "number" ? err.code : null;
    if (code !== null) {
      result.httpStatus = code;
      result.errorType = classifyHttpStatus(code);
    } else if (!result.errorType) {
      result.errorType = "client";
    }
  }

  // Count items in typical list responses
  result.itemCount = extractItemCount(obj);

  // Check for pagination tokens
  result.hasNextPage = hasNextPageToken(obj);

  return result;
}

// --- Helper Functions ---

function extractHttpStatus(obj: Record<string, unknown>): number | null {
  // Direct status field
  if (typeof obj.status === "number") return obj.status;
  if (typeof obj.code === "number") return obj.code;
  if (typeof obj.httpStatusCode === "number") return obj.httpStatusCode;

  // Nested error.code
  if (obj.error && typeof obj.error === "object") {
    const err = obj.error as Record<string, unknown>;
    if (typeof err.code === "number") return err.code;
    if (typeof err.status === "number") return err.status;
  }

  return null;
}

function classifyHttpStatus(status: number): GwsResultInfo["errorType"] {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "quota";
  if (status === 404) return "not_found";
  if (status >= 500 && status < 600) return "server";
  if (status >= 400 && status < 500) return "client";
  return null;
}

function classifyFromRawText(
  text: string,
  exitCode: number,
  result: GwsResultInfo,
): GwsResultInfo {
  const lower = text.toLowerCase();

  if (lower.includes("401") || lower.includes("unauthorized") || lower.includes("unauthenticated")) {
    result.errorType = "auth";
    result.httpStatus = 401;
    result.success = false;
  } else if (lower.includes("403") || lower.includes("forbidden") || lower.includes("permission denied")) {
    result.errorType = "auth";
    result.httpStatus = 403;
    result.success = false;
  } else if (lower.includes("429") || lower.includes("rate limit") || lower.includes("quota")) {
    result.errorType = "quota";
    result.httpStatus = 429;
    result.success = false;
  } else if (lower.includes("404") || lower.includes("not found")) {
    result.errorType = "not_found";
    result.httpStatus = 404;
    result.success = false;
  } else if (lower.includes("500") || lower.includes("internal server error")) {
    result.errorType = "server";
    result.httpStatus = 500;
    result.success = false;
  } else if (exitCode !== 0) {
    result.errorType = "client";
    result.success = false;
  }

  return result;
}

function extractItemCount(obj: Record<string, unknown>): number | null {
  // Google APIs use various list field names
  const listFields = [
    "files",
    "spreadsheets",
    "messages",
    "events",
    "users",
    "spaces",
    "items",
    "documents",
    "presentations",
    "calendars",
    "threads",
    "labels",
    "drafts",
    "contacts",
    "groups",
    "members",
    "tasks",
    "courses",
    "results",
    "values",
    "sheets",
    "replies",
    "comments",
    "revisions",
    "permissions",
    "drives",
    "changes",
  ];

  for (const field of listFields) {
    if (Array.isArray(obj[field])) {
      return (obj[field] as unknown[]).length;
    }
  }

  // If the response itself is an array
  if (Array.isArray(obj)) {
    return (obj as unknown[]).length;
  }

  // Check for resultSizeEstimate (Gmail)
  if (typeof obj.resultSizeEstimate === "number") {
    return obj.resultSizeEstimate as number;
  }

  return null;
}

function hasNextPageToken(obj: Record<string, unknown>): boolean {
  return (
    (typeof obj.nextPageToken === "string" && obj.nextPageToken.length > 0) ||
    (typeof obj.nextLink === "string" && obj.nextLink.length > 0)
  );
}
