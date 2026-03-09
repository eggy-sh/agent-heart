# Scenarios

Real workflows, real commands. Each scenario walks through what the agent is doing, what you run, and what you see.

---

## 1. Wrapping a GitHub PR Review

Your agent reviews pull requests. It lists open PRs, reads diffs, and posts comments using `gh`. You want to know which reviews finished and which ones hung.

### The commands

```bash
# Start the server (once)
npx @eggy.sh/agentpulse server start

# Wrap each gh call — lifecycle tracking is automatic
npx @eggy.sh/agentpulse exec \
  --service github --tool gh --resource pulls \
  -- gh pr list --repo acme/api --state open

npx @eggy.sh/agentpulse exec \
  --service github --tool gh --resource pulls \
  -- gh pr view 42 --repo acme/api

npx @eggy.sh/agentpulse exec \
  --service github --tool gh --resource reviews \
  -- gh pr review 42 --repo acme/api --approve
```

### What status shows

```bash
npx @eggy.sh/agentpulse status
```

```
SERVICE          TOOL   RESOURCE   STATUS      DURATION
github           gh     pulls      completed   1.2s
github           gh     pulls      completed   0.8s
github           gh     reviews    completed   2.1s
```

Three runs. All completed. No mystery.

If the third call had stalled — network timeout, auth prompt, rate limit — you'd see:

```
github           gh     reviews    stale       5m12s
```

That's the difference between "I think the review posted" and knowing it didn't.

---

## 2. Manual Lifecycle for a Database Migration

Not everything is a single CLI command. A migration script runs for minutes. It connects, applies schema changes across tables, backfills data. You want heartbeats while it works, and a clean signal when it finishes.

### Lock — signal the start

```bash
npx @eggy.sh/agentpulse lock db/migrate \
  --tool psql \
  --resource schemas \
  --message "Migrating users table to v3"
```

Output:

```json
{ "run_id": "run_k7xPm2", "status": "locked" }
```

Save that `run_id`. You'll need it.

### Beat — prove you're still alive

Your migration script sends heartbeats as it progresses:

```bash
npx @eggy.sh/agentpulse beat db/migrate \
  --run-id run_k7xPm2 \
  --message "Applied column additions (1/3)"

npx @eggy.sh/agentpulse beat db/migrate \
  --run-id run_k7xPm2 \
  --message "Backfilling email_verified (2/3)"

npx @eggy.sh/agentpulse beat db/migrate \
  --run-id run_k7xPm2 \
  --message "Dropping legacy columns (3/3)"
```

Each beat updates the timestamp and message. The server knows the run is alive.

### Unlock — signal completion

```bash
npx @eggy.sh/agentpulse unlock db/migrate \
  --run-id run_k7xPm2 \
  --exit-code 0
```

If the script fails halfway:

```bash
npx @eggy.sh/agentpulse unlock db/migrate \
  --run-id run_k7xPm2 \
  --exit-code 1 \
  --message "Foreign key constraint failed on orders.user_id"
```

### What happens when the script dies

If the script crashes and never sends `unlock`, the server detects it:

1. After `expected_cycle_ms` (default 5 minutes) — run transitions to `stale`
2. After `max_silence_ms` (default 10 minutes) — run transitions to `dead`

```bash
npx @eggy.sh/agentpulse status --filter stale,dead
```

```
SERVICE          TOOL   RESOURCE   STATUS   LAST HEARTBEAT   MESSAGE
db/migrate       psql   schemas    dead     12m ago          Backfilling email_verified (2/3)
```

The last heartbeat message tells you exactly where it stopped. Step 2 of 3. The backfill. Now you know where to look.

---

## 3. Multi-step Deploy Pipeline

An agent runs a deploy: lint, build, push image, apply to the cluster. Four steps. Each wrapped separately so you can see exactly where a failure occurred.

```bash
npx @eggy.sh/agentpulse exec \
  --service deploy --tool npm --resource lint \
  --session deploy-v2.3.1 \
  -- npm run lint

npx @eggy.sh/agentpulse exec \
  --service deploy --tool docker --resource images \
  --session deploy-v2.3.1 \
  -- docker build -t acme/api:v2.3.1 .

npx @eggy.sh/agentpulse exec \
  --service deploy --tool docker --resource registry \
  --session deploy-v2.3.1 \
  -- docker push acme/api:v2.3.1

npx @eggy.sh/agentpulse exec \
  --service deploy --tool kubectl --resource deployments \
  --session deploy-v2.3.1 \
  -- kubectl set image deployment/api api=acme/api:v2.3.1 -n production
```

All four share the same `--session` so you can query them together:

```bash
npx @eggy.sh/agentpulse runs --session deploy-v2.3.1
```

```
RUN ID       SERVICE   TOOL      RESOURCE      STATUS      EXIT   DURATION
run_a1b2c3   deploy    npm       lint          completed   0      4.2s
run_d4e5f6   deploy    docker    images        completed   0      38.1s
run_g7h8i9   deploy    docker    registry      completed   0      12.4s
run_j0k1l2   deploy    kubectl   deployments   failed      1      0.3s
```

Lint passed. Image built. Push succeeded. kubectl failed. Exit code 1. You know exactly which step broke and how far the deploy got.

---

## 4. Claude Code Session with Hooks

With hooks configured, every tool call Claude Code makes is tracked automatically. You don't wrap anything — it just happens.

### Setup (one time)

Add to `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "echo '$TOOL_INPUT' | npx @eggy.sh/agentpulse hook claude-code --event pre-tool-use"
      }]
    }],
    "PostToolUse": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "echo '$TOOL_INPUT' | npx @eggy.sh/agentpulse hook claude-code --event post-tool-use"
      }]
    }]
  }
}
```

### What happens during a session

You ask Claude to "fix the auth bug in user-service." Claude reads files, greps for patterns, edits code, runs tests. Each tool call flows through the hooks:

```
claude-code/Read      → lock → beat → unlock (completed, 0.1s)
claude-code/Grep      → lock → beat → unlock (completed, 0.3s)
claude-code/Edit      → lock → beat → unlock (completed, 0.1s)
claude-code/Bash      → lock → beat → unlock (completed, 8.4s)
claude-code/Bash      → lock → beat → unlock (failed, 2.1s)
claude-code/Edit      → lock → beat → unlock (completed, 0.1s)
claude-code/Bash      → lock → beat → unlock (completed, 6.2s)
```

Seven tool calls. Test failed on the fourth Bash (the first test run). Claude fixed the code and re-ran. All visible in one query:

```bash
npx @eggy.sh/agentpulse runs --service claude-code --json | jq '.[] | {tool: .tool_name, status, duration_ms}'
```

### Add a background watcher

While Claude works, set up a loop to catch problems:

```
/loop 3m check npx @eggy.sh/agentpulse runs --status stale --json and tell me if anything is stuck
```

If a Bash command hangs — waiting for input, hitting a rate limit, stuck on a network call — the loop catches it within three minutes. No silent failures.

---

## 5. Google Workspace File Sync

An agent manages documents in Google Drive. It lists files, downloads reports, uploads summaries. Each operation is a tracked run.

```bash
npx @eggy.sh/agentpulse exec \
  --service gws --tool gws --resource files \
  -- gws drive files list --folder "Quarterly Reports"

npx @eggy.sh/agentpulse exec \
  --service gws --tool gws --resource files \
  -- gws drive files export --file-id 1a2b3c --mime "text/csv" --out q4-revenue.csv

npx @eggy.sh/agentpulse exec \
  --service gws --tool gws --resource files \
  -- gws drive files upload --parent "Summaries" --file ./q4-summary.md
```

```bash
npx @eggy.sh/agentpulse status --service gws
```

```
SERVICE   TOOL   RESOURCE   STATUS      DURATION
gws       gws    files      completed   1.8s
gws       gws    files      completed   3.2s
gws       gws    files      completed   2.1s
```

If the upload stalls (large file, flaky connection), you see it go `stale` before it becomes a mystery.

---

## Naming Convention

Services follow a `<runtime>/<tool_or_family>` pattern:

| Service name | Meaning |
|---|---|
| `github` | GitHub operations via `gh` |
| `db/migrate` | Database migration scripts |
| `deploy` | Multi-step deploy pipeline |
| `claude-code/Bash` | Claude Code Bash tool calls |
| `claude-code/Read` | Claude Code file reads |
| `gws` | Google Workspace operations |
| `k8s` | Kubernetes operations via `kubectl` |

Pick names that make sense when you scan a status table. You'll be reading them at a glance, not in full sentences.
