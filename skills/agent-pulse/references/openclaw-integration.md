# OpenClaw Integration

OpenClaw is an AI assistant platform that executes CLI tools through an `exec`
tool with sandbox, host, and node execution modes. It has a plugin hook system
with `before_tool_call` and `after_tool_call` hooks.

There are three integration approaches. Pick one, or combine hooks + skill for
maximum coverage.

---

## Approach 1: Plugin Hooks (Automatic)

Every exec tool call is tracked automatically with no agent involvement.
Best for full coverage with zero overhead.

### Setup

Add to OpenClaw config (`~/.openclaw/config.json` or `.openclaw/config.json`):

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

OpenClaw pipes event JSON to agent-heart on every tool call.

### How It Works

For `exec` tool calls, the handler:
1. Extracts the binary name from the command (e.g., `gh` from `gh pr list`)
2. Maps it to a command family (e.g., `gh` → `github`)
3. Generates a service name (e.g., `openclaw/github`)
4. Parses the subcommand for resource kind (e.g., `pr` → `pulls`)
5. Sends `lock` on `before_tool_call`, `unlock` on `after_tool_call`

For non-exec tools (browser, memory, etc.), it sends simple lock/unlock events
using the tool type as the service name (e.g., `openclaw/browser`).

### Command Family Mapping

| Binary | Family | Service Name |
|---|---|---|
| `gh` | github | `openclaw/github` |
| `gws` | google-workspace | `openclaw/google-workspace` |
| `kubectl`, `helm` | kubernetes | `openclaw/kubernetes` |
| `docker`, `podman` | docker | `openclaw/docker` |
| `curl`, `wget` | http | `openclaw/http` |
| `aws` | aws | `openclaw/aws` |
| `gcloud` | gcp | `openclaw/gcp` |
| `terraform`, `tf` | terraform | `openclaw/terraform` |
| `npm`, `yarn`, `pnpm` | npm | `openclaw/npm` |
| `git` | git | `openclaw/git` |
| `psql`, `mysql` | database | `openclaw/database` |
| `ssh`, `scp` | ssh | `openclaw/ssh` |
| Other | (binary name) | `openclaw/<binary>` |

### GWS (Google Workspace) Deep Parsing

When the agent runs Google Workspace CLI commands, agent-heart parses the
command structure `gws <service> <resource> <method>` for rich metadata:

```bash
gws drive files list --params '{"pageSize": 10}'
# → service: openclaw/google-workspace
# → tool: gws
# → resource_kind: drive
# → method tracked in metadata
```

It classifies operations as read/write/delete/admin and detects pagination,
error types (auth, quota, not_found, server), and response item counts.

---

## Approach 2: Skill-Based (Agent-Driven)

Teach the OpenClaw agent to wrap important commands with `agent-heart exec`.
The agent decides when tracking matters. Best for enriched metadata on
high-value operations.

### Setup

Create a skill file at
`~/.openclaw/skills/agent-heart-observability/SKILL.md`:

```markdown
---
name: agent-heart-observability
description: >
  Wrap important CLI commands with agent-heart observability. Use when
  executing commands that interact with external services (GitHub, GWS,
  Kubernetes, databases, APIs). Skip for trivial local commands (echo,
  cat, ls, pwd).
requires:
  bins:
    - agent-heart
---

# Agent Pulse Observability

When executing CLI commands that interact with external services, wrap them
with agent-heart for lifecycle tracking.

## When to Wrap

Wrap commands that:
- Call external APIs (gh, gws, kubectl, aws, curl)
- Modify resources (create, update, delete operations)
- May take significant time (builds, deploys, data processing)
- Could fail silently (network calls, auth-dependent operations)

Skip wrapping for:
- Quick local operations (echo, cat, ls, pwd, cd)
- File reads that are part of normal analysis
- Commands that complete in under 1 second

## How to Wrap

```bash
npx agent-heart exec \
  --service openclaw/<family> \
  --tool <binary> \
  --resource <resource_kind> \
  -- <actual command>
```

## Examples

```bash
# GitHub operations
npx agent-heart exec --service openclaw/github --tool gh --resource pulls \
  -- gh pr list --repo myorg/myrepo

# Google Workspace
npx agent-heart exec --service openclaw/google-workspace --tool gws --resource drive \
  -- gws drive files list --params '{"pageSize": 10}'

# Kubernetes
npx agent-heart exec --service openclaw/kubernetes --tool kubectl --resource pods \
  -- kubectl get pods -n production

# Database queries
npx agent-heart exec --service openclaw/database --tool psql --resource query \
  -- psql -c "SELECT count(*) FROM users"
```
```

### What the Agent Does

With the skill loaded, the agent wraps important commands automatically:

```bash
agent-heart exec \
  --service openclaw/github \
  --tool gh \
  --resource pulls \
  -- gh pr list --repo myorg/myrepo
```

The agent skips wrapping trivial commands like `echo`, `cat`, `ls`.

---

## Approach 3: Hybrid (Hooks + Skill)

Use plugin hooks for automatic catch-all tracking, and the skill for enriched
metadata on important operations.

Best for production use where you want both full coverage and quality metadata.

Follow both Approach 1 and Approach 2 setup steps. They complement each other:
- Hooks catch every tool call, including ones the agent doesn't wrap
- Skills add richer metadata (explicit resource kinds, custom service names)

When both fire for the same command, you get two runs: one from the hook
(automatic, inferred metadata) and one from the exec wrapper (agent-provided
metadata). This is by design.

---

## What You See After Integration

```bash
$ npx agent-heart status

SERVICE                   STATUS      RUNS  STALE  DEAD
openclaw/github           completed      3      0     0
openclaw/kubernetes       active         1      0     0
openclaw/http             completed      1      0     0
openclaw/browser          completed      2      0     0
```

Detailed view:

```bash
$ npx agent-heart runs --service openclaw/github

RUN ID       TOOL     RESOURCE  STATUS     DURATION   EXIT
nk8f2a...    gh       pulls     completed  1.2s       0
j3k9x1...    gh       issues    completed  0.8s       0
m4p7q2...    gh       actions   completed  2.1s       0
```

---

## Troubleshooting

**Hook not firing:** Test manually:
```bash
echo '{"event":"before_tool_call","tool":"exec","params":{"command":"echo hello"},"session":{"id":"test"}}' | npx agent-heart hook openclaw
```

**Skill not loading:** Verify location and that `agent-heart` is available:
```bash
ls ~/.openclaw/skills/agent-heart-observability/SKILL.md
npx agent-heart --version
```

**Duplicate runs in hybrid mode:** Expected — the hook tracks the outer tool
call, the exec wrapper tracks the inner command with richer metadata. Filter by
service name to see only what you need.

**Server not reachable:** Ensure the server is running and the port matches
(default: 7778):
```bash
curl http://127.0.0.1:7778/api/v1/health
```
