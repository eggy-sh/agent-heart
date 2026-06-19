# Roadmap

## Phase 1: Core Runtime (current)

- `exec` wrapper with automatic lifecycle tracking
- `lock` / `beat` / `unlock` primitives
- Local server with SQLite storage
- `status` command with JSON output

## Phase 2: Agent Metadata

- Session and run correlation
- Duration and failure categorization
- Stale/dead classification tuning
- Verification gates — completed-but-unverified runs with a `verify` oversight verdict ✅

## Phase 3: Hook Integrations

- Claude Code hook package
- Generic shell-hook adapters
- CI/CD and cron integration examples

## Phase 4: Operational Views

- Active sessions dashboard
- Top failing tools
- Resource access breakdown
- Run timeline summaries

## Phase 5: Ecosystem

- OpenTelemetry export
- Prometheus metrics endpoint
- Notification plugins (Slack, PagerDuty, webhooks)
