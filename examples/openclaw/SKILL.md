---
name: agent-heart-observability
description: Track CLI tool execution with agent-heart lifecycle monitoring
version: 1.0.0
requires:
  bins:
    - agent-heart
tags:
  - observability
  - monitoring
  - tools
---

# Agent Pulse Observability

Use `agent-heart exec` to wrap important CLI operations so that every tool call is tracked with lifecycle monitoring (started, running, completed, or failed). This gives you visibility into what is executing, what finished, and what got stuck.

## When to Use

Wrap a command with `agent-heart exec` when:

- The command makes a **network request** or calls an **external API** (gh, curl, gws, kubectl)
- The command **modifies state** (creating PRs, deploying, writing to cloud resources)
- The command is **long-running** (builds, large file transfers, database migrations)
- You want to **track success or failure** of an operation for later review

## When NOT to Use

Do not wrap trivial or local-only commands:

- `echo`, `cat`, `ls`, `pwd`, `whoami`
- Quick file reads or writes to the local filesystem
- `cd`, `mkdir`, `touch`, `rm` on local files
- Simple string processing (`grep`, `sed`, `awk` on local data)
- `date`, `uname`, `env` (informational commands)

If the command completes in under a second and has no external side effects, run it directly without the wrapper.

## Syntax

```bash
agent-heart exec \
  --service <service> \
  --tool <tool_name> \
  --resource <resource_kind> \
  -- <command>
```

### Parameters

- `--service` (required): A namespace for the command family, formatted as `openclaw/<family>`. Examples: `openclaw/github`, `openclaw/kubernetes`, `openclaw/google-workspace`.
- `--tool` (required): The CLI binary being invoked. Examples: `gh`, `kubectl`, `gws`, `curl`.
- `--resource` (optional but recommended): The type of resource being operated on. Examples: `pulls`, `issues`, `pods`, `deployments`, `files`, `drive`.
- `--session` (optional): A session ID to correlate multiple operations. Use this when performing a series of related operations.
- `--meta` (optional): Additional key=value metadata pairs. Example: `--meta repo=myorg/myrepo --meta env=production`.

## Examples

### GitHub CLI (gh)

```bash
# List pull requests
agent-heart exec \
  --service openclaw/github \
  --tool gh \
  --resource pulls \
  -- gh pr list --repo myorg/myrepo

# Create an issue
agent-heart exec \
  --service openclaw/github \
  --tool gh \
  --resource issues \
  -- gh issue create --title "Bug: login broken" --body "Steps to reproduce..."

# Check workflow runs
agent-heart exec \
  --service openclaw/github \
  --tool gh \
  --resource actions \
  -- gh run list --repo myorg/myrepo --limit 5
```

### Google Workspace CLI (gws)

```bash
# List drive files
agent-heart exec \
  --service openclaw/google-workspace \
  --tool gws \
  --resource drive \
  -- gws drive files list --query "name contains 'report'"

# Send an email
agent-heart exec \
  --service openclaw/google-workspace \
  --tool gws \
  --resource gmail \
  -- gws gmail messages send --to user@example.com --subject "Update" --body "..."

# List calendar events
agent-heart exec \
  --service openclaw/google-workspace \
  --tool gws \
  --resource calendar \
  -- gws calendar events list --calendar primary --max-results 10
```

### Kubernetes (kubectl)

```bash
# Get pods
agent-heart exec \
  --service openclaw/kubernetes \
  --tool kubectl \
  --resource pods \
  -- kubectl get pods -n production

# Apply a manifest
agent-heart exec \
  --service openclaw/kubernetes \
  --tool kubectl \
  --resource deployments \
  -- kubectl apply -f deployment.yaml

# View logs
agent-heart exec \
  --service openclaw/kubernetes \
  --tool kubectl \
  --resource logs \
  -- kubectl logs -n production deploy/api-server --tail=100
```

### HTTP requests (curl)

```bash
# GET request to an API
agent-heart exec \
  --service openclaw/http \
  --tool curl \
  --resource api \
  -- curl -s https://api.example.com/v1/status

# POST request
agent-heart exec \
  --service openclaw/http \
  --tool curl \
  --resource api \
  -- curl -s -X POST https://api.example.com/v1/deploy -d '{"version": "1.2.3"}'
```

### Docker

```bash
# List running containers
agent-heart exec \
  --service openclaw/docker \
  --tool docker \
  --resource containers \
  -- docker ps

# Build an image
agent-heart exec \
  --service openclaw/docker \
  --tool docker \
  --resource images \
  -- docker build -t myapp:latest .
```

## What Happens

When you wrap a command with `agent-heart exec`:

1. A `lock` is sent to the agent-heart server (marks the run as started)
2. Periodic `beat` heartbeats are sent while the command runs
3. An `unlock` is sent when the command completes, with the exit code and duration

If the command hangs or the process dies, the agent-heart server detects the missing heartbeats and marks the run as `stale` then `dead`.

You can check on all tracked operations by running:

```bash
agent-heart status
```
