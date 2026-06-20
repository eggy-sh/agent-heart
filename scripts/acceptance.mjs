#!/usr/bin/env node
/**
 * End-to-end acceptance suite for agent-heart.
 *
 * This is the "does the product actually do what we sell?" test. Unlike the
 * vitest unit/integration suite (which mocks fetch and calls the Hono app in
 * process), this spawns the REAL built CLI (`dist/cli.js`) as a customer would,
 * against a REAL server process, in a fully isolated HOME + temp database.
 *
 * Every scenario maps to a documented capability (see docs/scenarios.md) and is
 * evaluated by explicit pass/fail assertions under identical conditions. Each
 * scenario passes only if ALL of its assertions hold. The script prints an
 * evidence log per scenario and exits non-zero if any scenario fails.
 *
 *   node scripts/acceptance.mjs        # run the full set
 *   npm run acceptance
 *
 * Requires a Node that can run the toolchain (>= 18; CI uses node@24).
 */

import { spawnSync, spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CLI = join(ROOT, "dist", "cli.js");
const NODE = process.execPath;

// --- Isolated environment -------------------------------------------------

const PORT = 30000 + Math.floor(Math.random() * 9000);
const BASE = `http://127.0.0.1:${PORT}`;
const HOME = mkdtempSync(join(tmpdir(), "agent-heart-accept-"));
const CONFIG_DIR = join(HOME, ".agent-heart");
mkdirSync(CONFIG_DIR, { recursive: true });
const DB_PATH = join(CONFIG_DIR, "pulse.db");
const SERVER_LOG = join(HOME, "server.log");

// Short monitor thresholds make stale/dead observable in seconds. Only the
// dedicated stale-/dead-test services get short per-service limits; everything
// else inherits the generous defaults so nothing transitions by accident.
const CONFIG = {
  server: { host: "127.0.0.1", port: PORT },
  monitor: {
    check_interval_ms: 150,
    default_expected_cycle_ms: 60_000,
    default_max_silence_ms: 120_000,
  },
  services: [
    { name: "stale-svc", expected_cycle_ms: 300, max_silence_ms: 3_600_000 },
    { name: "dead-svc", expected_cycle_ms: 200, max_silence_ms: 700 },
    {
      name: "claude",
      expected_cycle_ms: 600_000,
      max_silence_ms: 1_200_000,
      budget_usd: 20.0,
    },
    {
      name: "claude-burner",
      expected_cycle_ms: 600_000,
      max_silence_ms: 1_200_000,
      budget_usd: 1.0,
    },
  ],
  database: { path: DB_PATH },
  redact: {
    enabled: true,
    patterns: ["password", "secret", "token", "key", "auth", "credential"],
  },
};
writeFileSync(join(CONFIG_DIR, "config.json"), JSON.stringify(CONFIG, null, 2));

const baseEnv = { ...process.env, HOME, NO_COLOR: "1", FORCE_COLOR: "0" };
delete baseEnv.AGENT_HEART_RUN_ID; // top-level runs must not inherit a parent

// --- Low-level helpers ----------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Invoke the built CLI synchronously, exactly as a user would. */
function cli(args, { input, env } = {}) {
  const res = spawnSync(NODE, [CLI, ...args], {
    input,
    encoding: "utf-8",
    env: { ...baseEnv, ...env },
    timeout: 30_000,
  });
  return {
    code: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

/** Parse the JSON document a `--json` command prints to stdout. */
function cliJson(args, opts) {
  const r = cli(args, opts);
  const text = r.stdout.trim();
  try {
    return { ...r, json: JSON.parse(text) };
  } catch {
    return { ...r, json: null };
  }
}

async function api(path) {
  // localhost connections can transiently reset while the synchronous sql.js
  // server flushes the DB under load; retry briefly, exactly as the real
  // `watch` client does, so a blip never fails an assertion.
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(`${BASE}${path}`);
      return res.json();
    } catch (e) {
      lastErr = e;
      await sleep(120);
    }
  }
  throw lastErr;
}

async function allRuns() {
  const data = await api("/api/v1/runs?limit=500");
  return data.runs ?? [];
}

async function runById(id) {
  return (await allRuns()).find((r) => r.run_id === id) ?? null;
}

async function waitFor(predicate, { timeout = 4000, every = 100 } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await predicate();
    if (v) return v;
    if (Date.now() - start >= timeout) return null;
    await sleep(every);
  }
}

// --- Scenario framework ---------------------------------------------------

const results = [];

async function scenario(id, name, capability, fn) {
  const assertions = [];
  const evidence = [];
  const ctx = {
    assert(ok, msg, detail) {
      assertions.push({ ok: !!ok, msg, detail });
      if (!ok) throw new AssertionFailed(msg, detail);
    },
    record(label, value) {
      evidence.push({ label, value });
    },
  };
  let error = null;
  try {
    await fn(ctx);
  } catch (e) {
    if (!(e instanceof AssertionFailed)) {
      error = e instanceof Error ? `${e.message}\n${e.stack}` : String(e);
    }
  }
  const passed = assertions.length > 0 && assertions.every((a) => a.ok) && !error;
  results.push({ id, name, capability, passed, assertions, evidence, error });
  process.stderr.write(
    `${passed ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${id}  ${name}\n`,
  );
}

class AssertionFailed extends Error {
  constructor(message, detail) {
    super(message);
    this.detail = detail;
  }
}

// --- Server lifecycle -----------------------------------------------------

let serverProc;

async function startServer() {
  serverProc = spawn(NODE, [CLI, "server", "start"], {
    env: baseEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProc.stdout.on("data", (b) => appendFileSync(SERVER_LOG, b));
  serverProc.stderr.on("data", (b) => appendFileSync(SERVER_LOG, b));

  const up = await waitFor(
    async () => {
      try {
        const r = await fetch(`${BASE}/api/v1/health`);
        return r.ok;
      } catch {
        return false;
      }
    },
    { timeout: 8000, every: 150 },
  );
  if (!up) throw new Error(`Server did not become healthy on ${BASE}`);
}

function stopServer() {
  if (serverProc && !serverProc.killed) {
    serverProc.kill("SIGTERM");
  }
}

// --- The scenarios --------------------------------------------------------

async function runScenarios() {
  // S1 — exec wraps a command; full lifecycle is automatic; child succeeds.
  await scenario(
    "S1",
    "exec wraps a successful command (auto lock→beat→unlock)",
    "exec / automatic lifecycle",
    async (t) => {
      const r = cli([
        "exec",
        "--service",
        "github",
        "--tool",
        "gh",
        "--resource",
        "pulls",
        "--",
        NODE,
        "-e",
        "process.exit(0)",
      ]);
      t.record("exec exit code", r.code);
      t.assert(r.code === 0, "exec exits 0 when the child succeeds", r.code);

      const run = await waitFor(async () =>
        (await allRuns()).find(
          (x) => x.service_name === "github" && x.status === "completed",
        ),
      );
      t.assert(run, "a completed run was recorded for service=github");
      t.record("run", { status: run.status, exit_code: run.exit_code, tool: run.tool_name });
      t.assert(run.exit_code === 0, "recorded exit_code is 0", run.exit_code);
      t.assert(run.tool_name === "gh", "tool name captured", run.tool_name);
      t.assert(
        run.resource_kind === "pulls",
        "resource kind captured",
        run.resource_kind,
      );
    },
  );

  // S2 — exec propagates a non-zero child exit and marks the run failed.
  await scenario(
    "S2",
    "exec propagates failure (child exit 1 → run failed, critical)",
    "exec / exit-code fidelity",
    async (t) => {
      const r = cli([
        "exec",
        "--service",
        "deploy",
        "--tool",
        "kubectl",
        "--",
        NODE,
        "-e",
        "process.exit(1)",
      ]);
      t.record("exec exit code", r.code);
      t.assert(r.code === 1, "exec mirrors the child's exit code (1)", r.code);

      const run = await waitFor(async () =>
        (await allRuns()).find(
          (x) => x.service_name === "deploy" && x.status === "failed",
        ),
      );
      t.assert(run, "a failed run was recorded for service=deploy");
      t.record("run", { status: run.status, exit_code: run.exit_code, severity: run.severity });
      t.assert(run.exit_code === 1, "recorded exit_code is 1", run.exit_code);
      t.assert(
        run.severity === "critical",
        "a failed run is critical severity",
        run.severity,
      );
    },
  );

  // S3 — secrets in the wrapped command are redacted before storage.
  await scenario(
    "S3",
    "exec redacts secrets in the recorded command",
    "redaction",
    async (t) => {
      const r = cli([
        "exec",
        "--service",
        "secret-svc",
        "--tool",
        "gh",
        "--",
        NODE,
        "-e",
        "process.exit(0)",
        "--",
        "--token",
        "ghp_SUPERSECRET123",
      ]);
      t.assert(r.code === 0, "exec exits 0", r.code);

      const run = await waitFor(async () =>
        (await allRuns()).find((x) => x.service_name === "secret-svc"),
      );
      t.assert(run, "run recorded for service=secret-svc");
      t.record("stored command", run.command);
      t.assert(
        !run.command.includes("ghp_SUPERSECRET123"),
        "the raw secret never reaches storage",
        run.command,
      );
      t.assert(
        run.command.includes("[REDACTED]"),
        "the secret is replaced with [REDACTED]",
        run.command,
      );
    },
  );

  // S4 — manual lock → beat → unlock lifecycle for a long-running script.
  await scenario(
    "S4",
    "manual lock/beat/unlock lifecycle",
    "manual lifecycle / heartbeats",
    async (t) => {
      const lock = cliJson([
        "--json",
        "lock",
        "db/migrate",
        "--tool",
        "psql",
        "--resource",
        "schemas",
        "-m",
        "Migrating users table to v3",
      ]);
      t.assert(lock.json && lock.json.run_id, "lock returns a run_id", lock.stdout);
      const runId = lock.json.run_id;
      t.record("run_id", runId);
      t.assert(lock.json.status === "locked", "new run is locked", lock.json.status);

      const beat = cliJson([
        "--json",
        "beat",
        "db/migrate",
        "--run-id",
        runId,
        "-m",
        "Backfilling email_verified (2/3)",
      ]);
      t.assert(
        beat.json && beat.json.status === "active",
        "a beat transitions locked → active",
        beat.stdout,
      );

      const unlock = cliJson([
        "--json",
        "unlock",
        "db/migrate",
        "--run-id",
        runId,
        "--exit-code",
        "0",
      ]);
      t.assert(
        unlock.json && unlock.json.status === "completed",
        "unlock with exit 0 completes the run",
        unlock.stdout,
      );

      const run = await runById(runId);
      t.record("final", { status: run.status, message: run.message });
      t.assert(run.status === "completed", "run is completed in the store", run.status);
    },
  );

  // S5 — a run with no heartbeats crosses the stale threshold.
  await scenario(
    "S5",
    "stale detection (no heartbeat past expected cycle)",
    "stuck-run detection",
    async (t) => {
      const lock = cliJson([
        "--json",
        "lock",
        "stale-svc",
        "--tool",
        "worker",
        "-m",
        "started, will go quiet",
      ]);
      const runId = lock.json.run_id;
      t.record("run_id", runId);

      const stale = await waitFor(
        async () => {
          const run = await runById(runId);
          return run && run.status === "stale" ? run : null;
        },
        { timeout: 4000 },
      );
      t.assert(stale, "the silent run transitions to stale");
      t.record("observed", { status: stale.status, severity: stale.severity });
      t.assert(stale.severity === "warning", "a stale run is warning severity", stale.severity);
    },
  );

  // S6 — a longer silence escalates a run to dead, preserving the last message.
  await scenario(
    "S6",
    "dead detection (silent past max silence; last message preserved)",
    "silent-failure detection",
    async (t) => {
      const lock = cliJson([
        "--json",
        "lock",
        "dead-svc",
        "--tool",
        "worker",
        "-m",
        "Backfilling email_verified (2/3)",
      ]);
      const runId = lock.json.run_id;
      t.record("run_id", runId);

      const dead = await waitFor(
        async () => {
          const run = await runById(runId);
          return run && run.status === "dead" ? run : null;
        },
        { timeout: 4000 },
      );
      t.assert(dead, "the silent run transitions to dead");
      t.record("observed", { status: dead.status, severity: dead.severity, message: dead.message });
      t.assert(dead.severity === "critical", "a dead run is critical severity", dead.severity);
      t.assert(
        dead.message === "Backfilling email_verified (2/3)",
        "the last heartbeat message is preserved (tells you where it stopped)",
        dead.message,
      );
    },
  );

  // S7 — a multi-step pipeline shares one session and is queried together.
  await scenario(
    "S7",
    "multi-step pipeline grouped by session",
    "session grouping",
    async (t) => {
      const session = "deploy-v2.3.1";
      const steps = [
        { service: "deploy", tool: "npm", code: 0 },
        { service: "deploy", tool: "docker", code: 0 },
        { service: "deploy", tool: "kubectl", code: 1 },
      ];
      for (const s of steps) {
        cli([
          "exec",
          "--service",
          s.service,
          "--tool",
          s.tool,
          "--session",
          session,
          "--",
          NODE,
          "-e",
          `process.exit(${s.code})`,
        ]);
      }

      const res = cliJson(["--json", "runs", "--session", session]);
      t.assert(res.json, "runs --session returns JSON", res.stdout);
      t.record("total", res.json.total);
      t.assert(res.json.total === 3, "all three steps are grouped in the session", res.json.total);
      const failed = res.json.runs.filter((r) => r.status === "failed");
      const completed = res.json.runs.filter((r) => r.status === "completed");
      t.assert(completed.length === 2, "two steps completed", completed.length);
      t.assert(failed.length === 1, "one step failed", failed.length);
      t.assert(
        failed[0].tool_name === "kubectl",
        "the failure is attributed to the kubectl step",
        failed[0].tool_name,
      );
    },
  );

  // S8 — dynamic sub-threads attach to the orchestrator automatically.
  await scenario(
    "S8",
    "orchestration tree via env auto-parenting (any harness)",
    "dynamic sub-threads / trees",
    async (t) => {
      const orch = join(HOME, "orchestrate.sh");
      writeFileSync(
        orch,
        [
          "#!/usr/bin/env bash",
          "set -e",
          `"$AH_NODE" "$AH_CLI" exec --service extract-module --tool agent -- "$AH_NODE" -e "process.exit(0)"`,
          `"$AH_NODE" "$AH_CLI" exec --service run-tests --tool vitest -- "$AH_NODE" -e "process.exit(0)"`,
          "",
        ].join("\n"),
      );

      const r = cli(
        ["exec", "--service", "refactor-api", "--tool", "orchestrator", "--", "bash", orch],
        { env: { AH_NODE: NODE, AH_CLI: CLI } },
      );
      t.assert(r.code === 0, "the orchestrator exits 0", r.stderr);

      const root = await waitFor(async () =>
        (await allRuns()).find((x) => x.service_name === "refactor-api"),
      );
      t.assert(root, "orchestrator run recorded");
      t.record("root run_id", root.run_id);

      const tree = await api(`/api/v1/runs/${root.run_id}/tree`);
      t.record("tree total", tree.total);
      t.assert(tree.total === 3, "the subtree has the root + 2 children", tree.total);
      const children = tree.runs.filter((x) => x.parent_run_id === root.run_id);
      const childServices = children.map((c) => c.service_name).sort();
      t.record("children", childServices);
      t.assert(
        children.length === 2,
        "both sub-tasks auto-attached as direct children (no flags wired)",
        children.length,
      );
      t.assert(
        childServices.includes("extract-module") && childServices.includes("run-tests"),
        "the children are the two spawned sub-tasks",
        childServices,
      );
    },
  );

  // S9 — a budget gates a self-halting loop; spend --fail-over-budget exits non-zero.
  await scenario(
    "S9",
    "budget self-halt (spend --fail-over-budget exit codes + severity)",
    "cost / budget monitoring",
    async (t) => {
      // Under budget: 19.40 / 20.00 = 97% → warning, not over.
      const u = cliJson(["--json", "lock", "claude", "--tool", "model"]);
      cli([
        "unlock",
        "claude",
        "--run-id",
        u.json.run_id,
        "--exit-code",
        "0",
        "--cost",
        "19.40",
        "--tokens",
        "1800000",
      ]);
      // Over budget: 1.50 / 1.00 = 150% → critical, over.
      const b = cliJson(["--json", "lock", "claude-burner", "--tool", "model"]);
      cli([
        "unlock",
        "claude-burner",
        "--run-id",
        b.json.run_id,
        "--exit-code",
        "0",
        "--cost",
        "1.50",
        "--tokens",
        "50000",
      ]);

      const under = cli(["spend", "--service", "claude", "--fail-over-budget"]);
      t.record("under-budget exit", under.code);
      t.assert(under.code === 0, "a service under budget exits 0 (loop continues)", under.code);

      const over = cli(["spend", "--service", "claude-burner", "--fail-over-budget"]);
      t.record("over-budget exit", over.code);
      t.assert(over.code === 1, "an over-budget service exits 1 (loop self-halts)", over.code);

      const spend = cliJson(["--json", "spend"]);
      const claude = spend.json.services.find((s) => s.key === "claude");
      const burner = spend.json.services.find((s) => s.key === "claude-burner");
      t.record("claude budget", claude.budget.cost_usd);
      t.record("burner budget", burner.budget.cost_usd);
      t.assert(claude.budget.cost_usd.pct === 97, "claude is at 97% of budget", claude.budget.cost_usd.pct);
      t.assert(claude.budget.severity === "warning", "claude is a warning", claude.budget.severity);
      t.assert(burner.budget.cost_usd.pct === 150, "burner is at 150% of budget", burner.budget.cost_usd.pct);
      t.assert(burner.budget.severity === "critical", "burner is critical", burner.budget.severity);
      t.assert(
        spend.json.over_budget.includes("claude-burner") &&
          !spend.json.over_budget.includes("claude"),
        "only the over-budget service is flagged",
        spend.json.over_budget,
      );
    },
  );

  // S10 — oversight gate: finished-but-unverified is distinct from trusted.
  await scenario(
    "S10",
    "verification gate (needs-verify → unverified list → pass/fail verdict)",
    "oversight / verify-after-self-review",
    async (t) => {
      // A run that finishes flagged for oversight.
      const a = cliJson(["--json", "lock", "fix-auth", "--tool", "agent"]);
      const passId = a.json.run_id;
      cli(["unlock", "fix-auth", "--run-id", passId, "--exit-code", "0", "--needs-verify"]);

      let run = await runById(passId);
      t.record("after needs-verify", { status: run.status, verification: run.verification });
      t.assert(run.status === "completed", "the run is completed", run.status);
      t.assert(run.verification === "pending", "but verification is pending (not yet trusted)", run.verification);

      const unverified = cliJson(["--json", "runs", "--unverified"]);
      t.assert(
        unverified.json.runs.some((r) => r.run_id === passId),
        "runs --unverified surfaces the unchecked run",
        unverified.json.total,
      );

      // A real check passes it.
      cli(["verify", "--run-id", passId, "--pass", "-m", "integration tests green"]);
      run = await runById(passId);
      t.record("after verify --pass", run.verification);
      t.assert(run.verification === "passed", "verify --pass records a passed verdict", run.verification);

      const afterPass = cliJson(["--json", "runs", "--unverified"]);
      t.assert(
        !afterPass.json.runs.some((r) => r.run_id === passId),
        "a verified run drops off the unverified list",
        afterPass.json.total,
      );

      // A second run fails verification.
      const c = cliJson(["--json", "lock", "fix-auth", "--tool", "agent"]);
      const failId = c.json.run_id;
      cli(["unlock", "fix-auth", "--run-id", failId, "--exit-code", "0", "--needs-verify"]);
      cli(["verify", "--run-id", failId, "--fail", "-m", "auth test regressed"]);
      run = await runById(failId);
      t.record("after verify --fail", run.verification);
      t.assert(run.verification === "failed", "verify --fail records a failed verdict", run.verification);
    },
  );

  // S11 — walk away: watch blocks until a session resolves, exit code reflects outcome.
  await scenario(
    "S11",
    "watch resolves with status-reflecting exit codes (0 ok / 1 problem / 124 timeout)",
    "heartbeat / walk-away watch",
    async (t) => {
      // A session that finishes clean.
      cli(["exec", "--service", "ok-job", "--session", "watch-ok", "--", NODE, "-e", "process.exit(0)"]);
      cli(["exec", "--service", "ok-job", "--session", "watch-ok", "--", NODE, "-e", "process.exit(0)"]);
      const okWatch = cli(["watch", "--session", "watch-ok", "--timeout", "5"]);
      t.record("clean session watch exit", okWatch.code);
      t.assert(okWatch.code === 0, "watch exits 0 when every run completed", okWatch.code);

      // A session where a run failed.
      cli(["exec", "--service", "bad-job", "--session", "watch-bad", "--", NODE, "-e", "process.exit(1)"]);
      const badWatch = cli(["watch", "--session", "watch-bad", "--timeout", "5"]);
      t.record("failed session watch exit", badWatch.code);
      t.assert(badWatch.code === 1, "watch exits 1 when a run failed/died", badWatch.code);

      // A run that never resolves → timeout.
      const lock = cliJson(["--json", "lock", "claude", "--tool", "model", "-m", "hangs"]);
      const hangWatch = cli(["watch", "--run-id", lock.json.run_id, "--timeout", "1"]);
      t.record("hung run watch exit", hangWatch.code);
      t.assert(hangWatch.code === 124, "watch exits 124 on timeout", hangWatch.code);
    },
  );

  // S12 — harness hooks: a Claude Code tool call is tracked automatically + redacted.
  await scenario(
    "S12",
    "Claude Code hooks track a tool call end-to-end (with redaction)",
    "harness hook integration",
    async (t) => {
      const pre = JSON.stringify({
        session_id: "hooked",
        tool_name: "Bash",
        tool_input: { command: "gh auth login --token ghp_HOOKSECRET999" },
      });
      const preRes = cli(["hook", "claude-code", "--event", "pre-tool-use"], { input: pre });
      t.assert(preRes.code === 0, "pre-tool-use hook succeeds", preRes.stderr);

      const post = JSON.stringify({ session_id: "hooked", tool_name: "Bash", exit_code: 0 });
      const postRes = cli(["hook", "claude-code", "--event", "post-tool-use"], { input: post });
      t.assert(postRes.code === 0, "post-tool-use hook succeeds", postRes.stderr);

      const run = await waitFor(async () =>
        (await allRuns()).find((x) => x.service_name === "claude-code/Bash"),
      );
      t.assert(run, "the tool call was tracked as a run (no manual wrapping)");
      t.record("run", { status: run.status, command: run.command });
      t.assert(run.status === "completed", "pre→post drives lock→unlock to completed", run.status);
      t.assert(
        !run.command.includes("ghp_HOOKSECRET999"),
        "the hook redacts secrets before storage",
        run.command,
      );
      t.assert(run.command.includes("[REDACTED]"), "secret replaced with [REDACTED]", run.command);
    },
  );
}

// --- Report ---------------------------------------------------------------

function printReport() {
  const line = "─".repeat(74);
  process.stdout.write(`\n${line}\n  agent-heart — acceptance evidence\n${line}\n`);
  for (const r of results) {
    const mark = r.passed ? "PASS" : "FAIL";
    process.stdout.write(`\n[${mark}] ${r.id} — ${r.name}\n`);
    process.stdout.write(`       capability: ${r.capability}\n`);
    for (const e of r.evidence) {
      const v = typeof e.value === "object" ? JSON.stringify(e.value) : String(e.value);
      process.stdout.write(`       • ${e.label}: ${v}\n`);
    }
    for (const a of r.assertions) {
      const m = a.ok ? "✓" : "✗";
      const detail = a.ok || a.detail === undefined ? "" : `  (got: ${JSON.stringify(a.detail)})`;
      process.stdout.write(`       ${m} ${a.msg}${detail}\n`);
    }
    if (r.error) process.stdout.write(`       ! error: ${r.error}\n`);
  }
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  process.stdout.write(`\n${line}\n  ${passed}/${total} scenarios passed\n${line}\n`);
  return passed === total;
}

// --- Main -----------------------------------------------------------------

async function main() {
  process.stderr.write(`agent-heart acceptance — server ${BASE}, HOME ${HOME}\n\n`);
  let ok = false;
  try {
    await startServer();
    await runScenarios();
    ok = printReport();
  } finally {
    stopServer();
    if (process.env.KEEP_HOME) {
      process.stderr.write(`\n[KEEP_HOME] server log: ${SERVER_LOG}\n`);
    } else {
      try {
        rmSync(HOME, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e?.stack ?? e}\n`);
  stopServer();
  process.exit(1);
});
