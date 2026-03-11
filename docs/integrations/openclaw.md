# OpenClaw Integration Guide

[OpenClaw](https://github.com/openclaw/openclaw) is a personal AI assistant platform that executes CLI tools through an `exec` tool with sandbox, host, and node execution modes. It has a plugin hook system with `before_tool_call` and `after_tool_call` hooks, and a skills system where skills are SKILL.md files with YAML frontmatter.

## Why Agent Pulse for OpenClaw

OpenClaw agents execute dozens of CLI commands in a single session: `gh pr list`, `kubectl apply`, `gws drive files list`, `curl`, and more. Without observability, you cannot answer:

- Which commands did the agent run, and in what order?
- Did any command hang or silently fail?
- How long did each operation take?
- Which services and resources were accessed?

`agent-heart` fills this gap by tracking every tool call through the lock/beat/unlock lifecycle. Commands that hang are detected as stale, and commands that disappear are flagged as dead.

## Integration Approaches

There are three ways to integrate agent-heart with OpenClaw. You can use any one alone, or combine them.

### Approach 1: Skill-Based (Agent-Driven)

Teach the OpenClaw agent to wrap important commands with `agent-heart exec`. The agent decides when tracking matters based on the skill instructions.

**Best for**: Enriched metadata, selective tracking of high-value operations.

#### Setup

1. Start the server:

```bash
npx agent-heart init
npx agent-heart server start
```

2. Copy the skill file into your OpenClaw skills directory:

```bash
cp examples/openclaw/SKILL.md ~/.openclaw/skills/agent-heart-observability/SKILL.md
```

Or, if using a project-level skills directory:

```bash
cp examples/openclaw/SKILL.md .openclaw/skills/agent-heart-observability/SKILL.md
```

3. The agent will now see the skill and use `npx agent-heart exec` wrappers when appropriate.

#### What the Agent Does

With the skill loaded, the agent will wrap important commands like this:

```bash
npx agent-heart exec \
  --service openclaw/github \
  --tool gh \
  --resource pulls \
  -- gh pr list --repo myorg/myrepo
```

The agent will skip wrapping trivial commands like `echo`, `cat`, `ls`, and other quick local operations.

### Approach 2: Plugin Hooks (Automatic)

Configure OpenClaw's plugin system to send `before_tool_call` and `after_tool_call` events to agent-heart. Every exec tool call is tracked automatically with no agent involvement.

**Best for**: Full coverage with zero agent overhead, catch-all monitoring.

#### Setup

1. Start the server:

```bash
npx agent-heart init
npx agent-heart server start
```

2. Add the plugin configuration to your OpenClaw config file (`~/.openclaw/config.json` or `.openclaw/config.json`):

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

That is it. OpenClaw will pipe event JSON to agent-heart on every tool call.

#### How It Works

When OpenClaw makes a tool call, the plugin hook system:

1. Serializes the event as JSON (tool name, params, session info)
2. Pipes it to `npx agent-heart hook openclaw` via stdin
3. The handler parses the command, determines the service/tool/resource, and sends the appropriate lifecycle event

For `exec` tool calls, the handler:
- Extracts the binary name from the command (e.g., `gh` from `gh pr list`)
- Maps it to a command family (e.g., `gh` -> `github`)
- Generates a service name (e.g., `openclaw/github`)
- Parses the subcommand to determine the resource kind (e.g., `pr` -> `pulls`)

For non-exec tool calls (browser, memory, etc.), the handler sends simple lock/unlock events using the tool type as the service name (e.g., `openclaw/browser`).

### Approach 3: Hybrid (Hooks + Skills)

Use plugin hooks for automatic catch-all tracking, and the skill for enriched metadata on important operations.

**Best for**: Production use where you want both coverage and quality metadata.

#### Setup

Follow both Approach 1 and Approach 2 setup steps. The skill-based wrappers and hook-based tracking complement each other:

- **Hooks** catch every tool call, including ones the agent does not think to wrap
- **Skills** add richer metadata (explicit resource kinds, custom service names) for operations the agent identifies as important

When both fire for the same command, you get two runs tracked: one from the hook (automatic, with inferred metadata) and one from the exec wrapper (agent-provided metadata). This is by design -- the hook run tracks the outer tool call, while the exec wrapper tracks the inner command with enriched context.

## What You See After Integration

After an OpenClaw session that interacts with GitHub and Kubernetes:

```bash
$ npx agent-heart status

SERVICE                   STATUS      RUNS  STALE  DEAD
openclaw/github           completed      3      0     0
openclaw/kubernetes       active         1      0     0
openclaw/http             completed      1      0     0
openclaw/browser          completed      2      0     0
```

To see individual runs with details:

```bash
$ npx agent-heart status --service openclaw/github

RUN ID       TOOL     RESOURCE  STATUS     DURATION   EXIT
nk8f2a...    gh       pulls     completed  1.2s       0
j3k9x1...    gh       issues    completed  0.8s       0
m4p7q2...    gh       actions   completed  2.1s       0
```

To see only stuck or failed runs:

```bash
$ npx agent-heart status --filter stale,dead
```

For JSON output (useful for automation):

```bash
$ npx agent-heart status --json
```

## Event Mapping Reference

| OpenClaw Event | agent-heart Action | Service Name | Details |
|---|---|---|---|
| `before_tool_call` (exec) | `lock` | `openclaw/<command_family>` | Tracks command start |
| `after_tool_call` (exec) | `unlock` | `openclaw/<command_family>` | Records exit code and duration |
| `before_tool_call` (browser) | `lock` | `openclaw/browser` | Tracks non-exec tool start |
| `after_tool_call` (browser) | `unlock` | `openclaw/browser` | Records non-exec tool completion |

### Command Family Mapping

The hook handler maps CLI binaries to command families:

| Binary | Command Family | Service Name |
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
| Other | (binary name) | `openclaw/<binary>` |

## Troubleshooting

### Hook not firing

Make sure `agent-heart` is available via `npx`. Test by piping a sample event manually:

```bash
echo '{"event":"before_tool_call","tool":"exec","params":{"command":"echo hello"},"session":{"id":"test"}}' | npx agent-heart hook openclaw
```

Check for errors in the output. If you see `[agent-heart] Failed to parse OpenClaw hook event JSON`, the JSON input is malformed.

### Server not reachable

Ensure the agent-heart server is running:

```bash
npx agent-heart server start
```

Check that the port in your config matches (default: 7778):

```bash
curl http://127.0.0.1:7778/api/v1/overview
```

### No data appearing in status

If the server was not running when hooks fired, events are lost (fire-and-forget). Start the server first, then run your OpenClaw session.

Check that events are reaching the hook by adding temporary logging:

```bash
echo '{"event":"before_tool_call","tool":"exec","params":{"command":"gh pr list"},"session":{"id":"test-123"}}' | npx agent-heart hook openclaw && npx agent-heart status
```

### Skill not loading

Verify the skill file is in the correct location:

```bash
ls ~/.openclaw/skills/agent-heart-observability/SKILL.md
```

Make sure the YAML frontmatter is valid. Verify `agent-heart` is available:

```bash
npx agent-heart --version
```

### Redaction

agent-heart redacts sensitive values from commands before storing them. If you see `[REDACTED]` in your run data, this is working as intended. To adjust which patterns are redacted, edit `~/.agent-heart/config.json`:

```json
{
  "redact": {
    "enabled": true,
    "patterns": ["password", "secret", "token", "key", "auth", "credential"]
  }
}
```

### Duplicate runs in hybrid mode

When using both hooks and skills (Approach 3), you will see two runs for commands that the agent wraps with `agent-heart exec`. This is expected. The hook-created run tracks the outer exec tool call, while the skill-created run tracks the inner command with richer metadata. Filter by service name to see only the runs you care about.
