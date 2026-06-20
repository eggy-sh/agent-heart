import { describe, it, expect, vi, afterEach } from "vitest";
import { PulseClient } from "./client.js";

const BASE = "http://test.local";

function mockResponse(
  body: unknown,
  { ok = true, status = 200 }: { ok?: boolean; status?: number } = {},
): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function stubFetch(res: Response) {
  const fetchMock = vi.fn().mockResolvedValue(res);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function client() {
  return new PulseClient({ serverUrl: BASE, sessionId: "sess1" });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PulseClient heartbeat calls", () => {
  it("lock POSTs a lock heartbeat with session + options", async () => {
    const fetchMock = stubFetch(mockResponse({ ok: true, run_id: "r1", status: "locked" }));
    const res = await client().lock("svc", { tool_name: "gh" });

    expect(res.run_id).toBe("r1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/v1/heartbeat`);
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      service_name: "svc",
      action: "lock",
      session_id: "sess1",
      tool_name: "gh",
    });
  });

  it("unlock passes exit_code through", async () => {
    const fetchMock = stubFetch(mockResponse({ ok: true, run_id: "r1", status: "completed" }));
    await client().unlock("svc", { run_id: "r1", exit_code: 0 });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ action: "unlock", run_id: "r1", exit_code: 0 });
  });
});

describe("PulseClient query construction", () => {
  it("listRuns builds a filtered query string", async () => {
    const fetchMock = stubFetch(mockResponse({ runs: [], total: 0 }));
    await client().listRuns({ service: "x", status: "active", limit: 5 });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/api/v1/runs?");
    expect(url).toContain("service=x");
    expect(url).toContain("status=active");
    expect(url).toContain("limit=5");
  });

  it("listRuns with no params hits the bare endpoint", async () => {
    const fetchMock = stubFetch(mockResponse({ runs: [], total: 0 }));
    await client().listRuns();
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/v1/runs`);
  });

  it("spend builds a query string", async () => {
    const fetchMock = stubFetch(mockResponse({ timestamp: "", total: {}, services: [], sessions: [] }));
    await client().spend({ service: "claude" });
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/v1/spend?service=claude`);
  });

  it("getRunTree hits the tree endpoint", async () => {
    const fetchMock = stubFetch(mockResponse({ runs: [], total: 0 }));
    await client().getRunTree("r1");
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/v1/runs/r1/tree`);
  });

  it("verify POSTs the verdict", async () => {
    const fetchMock = stubFetch(mockResponse({ run_id: "r1", verification: "passed" }));
    await client().verify("r1", { status: "passed", message: "ok" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/v1/runs/r1/verify`);
    expect(JSON.parse(init.body)).toEqual({ status: "passed", message: "ok" });
  });
});

describe("PulseClient error handling", () => {
  it("throws with the HTTP status on a non-ok response", async () => {
    stubFetch(mockResponse("boom", { ok: false, status: 500 }));
    await expect(client().getRun("r1")).rejects.toThrow(/HTTP 500/);
  });

  it("getRunOrNull returns null on 404", async () => {
    stubFetch(mockResponse("not found", { ok: false, status: 404 }));
    await expect(client().getRunOrNull("r1")).resolves.toBeNull();
  });

  it("getRunOrNull rethrows non-404 errors", async () => {
    stubFetch(mockResponse("boom", { ok: false, status: 500 }));
    await expect(client().getRunOrNull("r1")).rejects.toThrow(/HTTP 500/);
  });
});
