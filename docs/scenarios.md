# Scenarios

Real workflows, real commands. Each scenario walks through what the agent is doing, what you run, and what you see.

---

## 1. Wrapping a GitHub PR Review

Your agent reviews pull requests. It lists open PRs, reads diffs, and posts comments using `gh`. You want to know which reviews finished and which ones hung.

### The commands

```bash
# Start the server (once)
npx agent-heart server start

# Wrap each gh call — lifecycle tracking is automatic
npx agent-heart exec \
  --service github --tool gh --resource pulls \
  -- gh pr list --repo acme/api --state open

npx agent-heart exec \
  --service github --tool gh --resource pulls \
  -- gh pr view 42 --repo acme/api

npx agent-heart exec \
  --service github --tool gh --resource reviews \
  -- gh pr review 42 --repo acme/api --approve
```

### What status shows

```bash
npx agent-heart status
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
npx agent-heart lock db/migrate \
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
npx agent-heart beat db/migrate \
  --run-id run_k7xPm2 \
  --message "Applied column additions (1/3)"

npx agent-heart beat db/migrate \
  --run-id run_k7xPm2 \
  --message "Backfilling email_verified (2/3)"

npx agent-heart beat db/migrate \
  --run-id run_k7xPm2 \
  --message "Dropping legacy columns (3/3)"
```

Each beat updates the timestamp and message. The server knows the run is alive.

### Unlock — signal completion

```bash
npx agent-heart unlock db/migrate \
  --run-id run_k7xPm2 \
  --exit-code 0
```

If the script fails halfway:

```bash
npx agent-heart unlock db/migrate \
  --run-id run_k7xPm2 \
  --exit-code 1 \
  --message "Foreign key constraint failed on orders.user_id"
```

### What happens when the script dies

If the script crashes and never sends `unlock`, the server detects it:

1. After `expected_cycle_ms` (default 5 minutes) — run transitions to `stale`
2. After `max_silence_ms` (default 10 minutes) — run transitions to `dead`

```bash
npx agent-heart status --filter stale,dead
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
npx agent-heart exec \
  --service deploy --tool npm --resource lint \
  --session deploy-v2.3.1 \
  -- npm run lint

npx agent-heart exec \
  --service deploy --tool docker --resource images \
  --session deploy-v2.3.1 \
  -- docker build -t acme/api:v2.3.1 .

npx agent-heart exec \
  --service deploy --tool docker --resource registry \
  --session deploy-v2.3.1 \
  -- docker push acme/api:v2.3.1

npx agent-heart exec \
  --service deploy --tool kubectl --resource deployments \
  --session deploy-v2.3.1 \
  -- kubectl set image deployment/api api=acme/api:v2.3.1 -n production
```

All four share the same `--session` so you can query them together:

```bash
npx agent-heart runs --session deploy-v2.3.1
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
        "command": "echo '$TOOL_INPUT' | npx agent-heart hook claude-code --event pre-tool-use"
      }]
    }],
    "PostToolUse": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "echo '$TOOL_INPUT' | npx agent-heart hook claude-code --event post-tool-use"
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
npx agent-heart runs --service claude-code --json | jq '.[] | {tool: .tool_name, status, duration_ms}'
```

### Add a background watcher

While Claude works, set up a loop to catch problems:

```
/loop 3m check npx agent-heart runs --status stale --json and tell me if anything is stuck
```

If a Bash command hangs — waiting for input, hitting a rate limit, stuck on a network call — the loop catches it within three minutes. No silent failures.

---

## 5. Google Workspace File Sync

An agent manages documents in Google Drive. It lists files, downloads reports, uploads summaries. Each operation is a tracked run.

```bash
npx agent-heart exec \
  --service gws --tool gws --resource files \
  -- gws drive files list --folder "Quarterly Reports"

npx agent-heart exec \
  --service gws --tool gws --resource files \
  -- gws drive files export --file-id 1a2b3c --mime "text/csv" --out q4-revenue.csv

npx agent-heart exec \
  --service gws --tool gws --resource files \
  -- gws drive files upload --parent "Summaries" --file ./q4-summary.md
```

```bash
npx agent-heart status --service gws
```

```
SERVICE   TOOL   RESOURCE   STATUS      DURATION
gws       gws    files      completed   1.8s
gws       gws    files      completed   3.2s
gws       gws    files      completed   2.1s
```

If the upload stalls (large file, flaky connection), you see it go `stale` before it becomes a mystery.

---

## 6. Orchestrating Sub-Agents (Dynamic Sub-Threads)

An orchestrator agent breaks a big job — "refactor the API package" — into sub-tasks it spins up dynamically: extract a module, update imports, run the tests. You want a single view of the whole tree and an instant read on whether any branch is stuck, without wiring run IDs through every layer.

### Auto-parenting — no manual wiring

Wrap the orchestrator in `exec`. Every nested `agent-heart` call inside automatically attaches as a child, because `exec` exports the current run id (`AGENT_HEART_RUN_ID`) to the child environment. This works in **any harness** — Claude Code, a bare shell, CI — since they all propagate environment variables to child processes.

```bash
npx agent-heart exec --service refactor-api --tool orchestrator -- ./refactor.sh
```

Inside `refactor.sh`, the sub-tasks need no special flags:

```bash
# These become children of the orchestrator run automatically.
npx agent-heart exec --service extract-module --tool agent -- ./extract.sh
npx agent-heart exec --service update-imports --tool agent -- ./update-imports.sh
npx agent-heart exec --service run-tests --tool vitest -- npm test
```

For manual lifecycles, pass `--parent <run-id>` (or export `AGENT_HEART_RUN_ID`) to `lock`.

### Seeing the tree

```bash
npx agent-heart status --tree
```

```
  refactor-api    orchestrator  active   1.7s (3 sub)
  ├─ extract-module  agent    completed  163ms
  └─ update-imports  agent    active     1.2s (1 sub) ⚠ subtree warning
     └─ run-tests     vitest   stale      1.1s
```

A stuck leaf bubbles up: the orchestrator row is annotated `⚠ subtree warning` because `run-tests` went `stale`, so you spot the problem branch from the root without expanding anything. `runs --tree` renders the same way, and `--json` returns the nested structure for an agent loop to act on. A remote orchestrator can also pull a subtree directly: `GET /api/v1/runs/:id/tree`.

---

## 7. A Self-Halting Loop on a Budget

You run a self-prompting agent loop overnight. It's productive — and it burns tokens fast. You want it to stop itself if it crosses a dollar limit rather than waking up to a drained account.

### Set a budget

```json
// ~/.agent-heart/config.json
{ "services": [ { "name": "claude", "expected_cycle_ms": 120000, "max_silence_ms": 300000, "budget_usd": 20.00 } ] }
```

### Report spend each iteration

After each model turn, the agent reports its cumulative tokens and cost (the latest value wins):

```bash
npx agent-heart beat claude --run-id "$RUN" --tokens "$TOKENS" --cost "$COST"
```

### Let the loop check itself

At the top of each iteration, the loop asks agent-heart whether it's still within budget. `spend --fail-over-budget` exits non-zero when the service is over budget:

```bash
while true; do
  npx agent-heart spend --service claude --fail-over-budget || {
    echo "Budget reached — stopping the loop."; break;
  }
  ./run-one-iteration.sh
done
```

### See where the money went

```bash
npx agent-heart spend
```

```
  claude   1.8M   $19.40   $19.40/$20.00 ██████████ 97%   142
```

The agent manages its own limit — no babysitting, no surprise bill.

---

## 8. Walk Away From a Long Refactor

An agent is refactoring a large codebase overnight. It spawns sub-tasks as it goes — extract modules, update imports, run tests. You don't want to sit watching `status`; you want one command that returns when it's done (or when something dies), and to be paged either way.

### Kick it off, then block on it

```bash
./start-refactor.sh   # spawns tracked runs under --session nightly-refactor

# One command that blocks until the whole session resolves, with a Slack ping on resolve
npx agent-heart watch --session nightly-refactor --timeout 14400 --webhook "$SLACK_WEBHOOK"
echo "exit: $?"   # 0 = all completed, 1 = something failed/died, 124 = timed out
```

`watch` polls quietly and re-reads the run set each tick, so the sub-tasks the agent spawns mid-run are picked up automatically. When the last run settles, it prints a summary, POSTs the webhook, and exits.

### Branch on the outcome

Because the exit code reflects the result, you can wire the whole thing into a pipeline and go to bed:

```bash
npx agent-heart watch --session nightly-refactor --timeout 14400 \
  && ./open-pr.sh \
  || ./page-me.sh "refactor did not finish cleanly"
```

### Or just set a death alarm

If you only care about catching a stall or crash:

```bash
npx agent-heart watch --session nightly-refactor --until dead,stale --webhook "$PAGER"
```

This returns the instant any run dies or goes stale — so you find out within seconds, not the next morning.

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
