# Automatic Observability for OpenClaw exec Tool Calls

The easiest setup for automatic observability on all exec tool calls in OpenClaw is **Approach 1: Plugin Hooks**. It requires no changes to your agent logic, no skill files, and no manual wrapping of commands. You configure it once and every exec tool call is tracked automatically.

## Step 1: Install and start agent-heart

```bash
npm install -g agent-heart
agent-heart init
agent-heart server start
```

The server runs locally on `127.0.0.1:7778` (SQLite-backed, single process). You can verify it is healthy with:

```bash
curl http://127.0.0.1:7778/api/v1/health
```

## Step 2: Add the plugin hook to your OpenClaw config

Open your OpenClaw config file (`~/.openclaw/config.json` or `.openclaw/config.json` in your project) and add the `agent-heart` plugin entry:

```json
{
  "plugins": {
    "agent-heart": {
      "hooks": {
        "before_tool_call": "npx agent-heart hook openclaw",
        "after_tool_call": "npx agent-heart hook openclaw"
      }
    }
  }
}
```

That is the entire setup. No skill files, no code changes, no wrapping individual commands.

## What happens automatically

When any exec tool call fires, OpenClaw pipes event JSON to agent-heart via the hook. The handler does the following for you:

1. Extracts the binary name from the command (e.g., `gh` from `gh pr list`).
2. Maps it to a known command family (e.g., `gh` maps to `github`, `kubectl` maps to `kubernetes`).
3. Generates a service name following the convention `openclaw/<family>` (e.g., `openclaw/github`).
4. Parses subcommands for resource kind (e.g., `pr` maps to `pulls`).
5. Sends a `lock` event on `before_tool_call` and an `unlock` event on `after_tool_call`.

For non-exec tools (browser, memory, etc.), it sends simple lock/unlock events using the tool type as the service name (e.g., `openclaw/browser`).

### Recognized command families

| Binary              | Family           | Service Name              |
|---------------------|------------------|---------------------------|
| `gh`                | github           | `openclaw/github`         |
| `gws`              | google-workspace | `openclaw/google-workspace` |
| `kubectl`, `helm`  | kubernetes       | `openclaw/kubernetes`     |
| `docker`, `podman` | docker           | `openclaw/docker`         |
| `curl`, `wget`     | http             | `openclaw/http`           |
| `aws`              | aws              | `openclaw/aws`            |
| `gcloud`           | gcp              | `openclaw/gcp`            |
| `terraform`, `tf`  | terraform        | `openclaw/terraform`      |
| `npm`, `yarn`, `pnpm` | npm           | `openclaw/npm`            |
| `git`              | git              | `openclaw/git`            |
| `psql`, `mysql`    | database         | `openclaw/database`       |
| `ssh`, `scp`       | ssh              | `openclaw/ssh`            |
| Any other binary    | (binary name)   | `openclaw/<binary>`       |

Sensitive flags (tokens, passwords, keys, auth values) are automatically redacted from tracked commands.

## Step 3: Verify it works

After running a few commands through your OpenClaw agent, check the results:

```bash
# High-level overview of all tracked services
agent-heart overview

# List recent runs
agent-heart runs

# Filter to a specific service
agent-heart runs --service openclaw/github

# Find stuck or failed runs
agent-heart runs --status stale
agent-heart runs --status dead
```

Example output:

```
SERVICE                   STATUS      RUNS  STALE  DEAD
openclaw/github           completed      3      0     0
openclaw/kubernetes       active         1      0     0
openclaw/http             completed      1      0     0
openclaw/browser          completed      2      0     0
```

## Optional: Tune stale/dead detection thresholds

By default, runs are marked stale after 5 minutes and dead after 10 minutes of silence. If your tool calls have different expected durations, configure per-service thresholds in `~/.agent-heart/config.json`:

```json
{
  "services": [
    {
      "name": "openclaw/github",
      "expected_cycle_ms": 60000,
      "max_silence_ms": 120000
    }
  ],
  "monitor": {
    "check_interval_ms": 30000,
    "default_expected_cycle_ms": 300000,
    "default_max_silence_ms": 600000
  }
}
```

- `expected_cycle_ms` -- how long a run should take before being flagged as stale.
- `max_silence_ms` -- how long without a heartbeat before being flagged as dead.

Set shorter values for fast API calls and longer values for builds or deployments.

## Troubleshooting

**Hook not firing:** Test the hook manually by piping sample JSON:

```bash
echo '{"event":"before_tool_call","tool":"exec","params":{"command":"echo hello"},"session":{"id":"test"}}' | npx agent-heart hook openclaw
```

**Server not reachable:** Make sure the server is running (`agent-heart server start`) and test with `curl http://127.0.0.1:7778/api/v1/health`.

**Runs stuck as "locked":** The monitor will mark them stale/dead after the configured thresholds. Check with `agent-heart runs --status locked`.

**Port conflict:** Change the port in `~/.agent-heart/config.json` under `server.port`.

## Going further

If you later want richer metadata on high-value operations, you can layer on a skill-based approach (Approach 2) alongside the hooks. The two complement each other: hooks provide automatic catch-all coverage, while the skill lets the agent add explicit resource kinds and custom service names to important commands. But for the easiest starting point with full coverage, the plugin hook configuration above is all you need.
