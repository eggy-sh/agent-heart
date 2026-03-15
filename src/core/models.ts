import { z } from "zod";

// --- Enums ---

export const RunStatus = {
  LOCKED: "locked",
  ACTIVE: "active",
  COMPLETED: "completed",
  FAILED: "failed",
  STALE: "stale",
  DEAD: "dead",
} as const;

export type RunStatus = (typeof RunStatus)[keyof typeof RunStatus];

export const HeartbeatAction = {
  LOCK: "lock",
  BEAT: "beat",
  UNLOCK: "unlock",
} as const;

export type HeartbeatAction =
  (typeof HeartbeatAction)[keyof typeof HeartbeatAction];

export const Severity = {
  OK: "ok",
  WARNING: "warning",
  CRITICAL: "critical",
} as const;

export type Severity = (typeof Severity)[keyof typeof Severity];

// --- Core Models ---

export interface Run {
  run_id: string;
  session_id: string | null;
  service_name: string;
  tool_name: string | null;
  command: string | null;
  command_family: string | null;
  resource_kind: string | null;
  resource_id: string | null;
  status: RunStatus;
  severity: Severity;
  message: string | null;
  exit_code: number | null;
  duration_ms: number | null;
  started_at: string;
  last_heartbeat: string;
  completed_at: string | null;
  metadata: Record<string, string>;
}

export interface ServiceState {
  service_name: string;
  status: RunStatus;
  severity: Severity;
  active_runs: number;
  stale_runs: number;
  dead_runs: number;
  last_heartbeat: string | null;
  expected_cycle_ms: number;
  max_silence_ms: number;
  consecutive_failures?: number;
}

export interface EndpointCheck {
  endpoint_id: string;
  url: string;
  method: string;
  expected_status: number;
  last_check: string | null;
  last_status: number | null;
  response_time_ms: number | null;
  healthy: boolean;
}

// --- API Request/Response ---

export const HeartbeatRequestSchema = z.object({
  service_name: z.string().min(1),
  action: z.enum(["lock", "beat", "unlock"]),
  run_id: z.string().optional(),
  session_id: z.string().optional(),
  tool_name: z.string().optional(),
  command: z.string().optional(),
  command_family: z.string().optional(),
  resource_kind: z.string().optional(),
  resource_id: z.string().optional(),
  message: z.string().optional(),
  exit_code: z.number().int().optional(),
  metadata: z.record(z.string()).optional(),
});

export type HeartbeatRequest = z.infer<typeof HeartbeatRequestSchema>;

export interface HeartbeatResponse {
  ok: boolean;
  run_id: string;
  service_name: string;
  action: HeartbeatAction;
  status: RunStatus;
  timestamp: string;
}

export interface OverviewResponse {
  timestamp: string;
  services: ServiceState[];
  runs: {
    active: number;
    stale: number;
    dead: number;
    completed: number;
    failed: number;
  };
  endpoints: EndpointCheck[];
}

export interface RunListResponse {
  runs: Run[];
  total: number;
}

// --- Configuration ---

export interface ServiceConfig {
  name: string;
  expected_cycle_ms: number;
  max_silence_ms: number;
  endpoints?: EndpointConfig[];
}

export interface EndpointConfig {
  url: string;
  method?: string;
  expected_status?: number;
  interval_ms?: number;
}

export interface PulseConfig {
  server: {
    host: string;
    port: number;
  };
  monitor: {
    check_interval_ms: number;
    default_expected_cycle_ms: number;
    default_max_silence_ms: number;
  };
  services: ServiceConfig[];
  database: {
    path: string;
  };
  redact: {
    enabled: boolean;
    patterns: string[];
  };
}

// --- Exec wrapper types ---

export interface ExecOptions {
  service_name: string;
  tool_name?: string;
  command_family?: string;
  resource_kind?: string;
  resource_id?: string;
  session_id?: string;
  run_id?: string;
  heartbeat_interval_ms?: number;
  metadata?: Record<string, string>;
}

export interface ExecResult {
  run_id: string;
  exit_code: number;
  duration_ms: number;
  stdout: string;
  stderr: string;
  status: "completed" | "failed";
}
