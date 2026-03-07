import { nanoid } from "nanoid";
import type {
  HeartbeatAction,
  HeartbeatRequest,
  HeartbeatResponse,
  OverviewResponse,
  Run,
  RunListResponse,
} from "./models.js";
import { getServerUrl, loadConfig } from "./config.js";

export interface PulseClientOptions {
  serverUrl?: string;
  sessionId?: string;
  timeout?: number;
}

export class PulseClient {
  private serverUrl: string;
  private sessionId: string;
  private timeout: number;

  constructor(options: PulseClientOptions = {}) {
    this.serverUrl = options.serverUrl ?? getServerUrl();
    this.sessionId = options.sessionId ?? nanoid();
    this.timeout = options.timeout ?? 5000;
  }

  private async request<T>(
    path: string,
    options: RequestInit = {},
  ): Promise<T> {
    const url = `${this.serverUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...options.headers,
        },
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body}`);
      }

      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private async sendHeartbeat(
    serviceName: string,
    action: HeartbeatAction,
    options: Partial<HeartbeatRequest> = {},
  ): Promise<HeartbeatResponse> {
    const body: HeartbeatRequest = {
      service_name: serviceName,
      action,
      session_id: this.sessionId,
      ...options,
    };

    return this.request<HeartbeatResponse>("/api/v1/heartbeat", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async lock(
    serviceName: string,
    options: Partial<HeartbeatRequest> = {},
  ): Promise<HeartbeatResponse> {
    return this.sendHeartbeat(serviceName, "lock", options);
  }

  async beat(
    serviceName: string,
    options: Partial<HeartbeatRequest> = {},
  ): Promise<HeartbeatResponse> {
    return this.sendHeartbeat(serviceName, "beat", options);
  }

  async unlock(
    serviceName: string,
    options: Partial<HeartbeatRequest> = {},
  ): Promise<HeartbeatResponse> {
    return this.sendHeartbeat(serviceName, "unlock", options);
  }

  async getRun(runId: string): Promise<Run> {
    return this.request<Run>(`/api/v1/runs/${runId}`);
  }

  async listRuns(params?: {
    service?: string;
    status?: string;
    session_id?: string;
    limit?: number;
  }): Promise<RunListResponse> {
    const query = new URLSearchParams();
    if (params?.service) query.set("service", params.service);
    if (params?.status) query.set("status", params.status);
    if (params?.session_id) query.set("session_id", params.session_id);
    if (params?.limit) query.set("limit", String(params.limit));

    const qs = query.toString();
    return this.request<RunListResponse>(
      `/api/v1/runs${qs ? `?${qs}` : ""}`,
    );
  }

  async overview(): Promise<OverviewResponse> {
    return this.request<OverviewResponse>("/api/v1/overview");
  }

  // Context manager pattern for tracking runs
  async trackRun<T>(
    serviceName: string,
    fn: (runId: string) => Promise<T>,
    options: Partial<HeartbeatRequest> = {},
  ): Promise<T> {
    const lockRes = await this.lock(serviceName, options);
    const runId = lockRes.run_id;
    let beatInterval: ReturnType<typeof setInterval> | null = null;

    try {
      beatInterval = setInterval(
        () => {
          this.beat(serviceName, { run_id: runId }).catch(() => {});
        },
        options.metadata?.heartbeat_interval_ms
          ? Number(options.metadata.heartbeat_interval_ms)
          : 15_000,
      );

      const result = await fn(runId);
      await this.unlock(serviceName, { run_id: runId, exit_code: 0 });
      return result;
    } catch (error) {
      await this.unlock(serviceName, {
        run_id: runId,
        exit_code: 1,
        message:
          error instanceof Error ? error.message : "Unknown error",
      });
      throw error;
    } finally {
      if (beatInterval) clearInterval(beatInterval);
    }
  }
}

export default PulseClient;
