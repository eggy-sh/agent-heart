#!/usr/bin/env bash
# Example: Track a GitHub CLI command with agent-heart
#
# This wraps `gh pr list` with automatic lifecycle tracking.
# agent-heart will:
#   1. Lock a run before the command starts
#   2. Send periodic heartbeats while it runs
#   3. Unlock the run when it finishes (with exit code and duration)
#
# If the command hangs or the process dies, agent-heart will detect
# the missing heartbeat and mark the run as stale, then dead.
#
# Prerequisites:
#   - agent-heart installed: npm install -g agent-heart
#   - agent-heart server running: agent-heart server start
#   - gh CLI installed and authenticated

set -euo pipefail

# Basic usage — wraps the command with full lifecycle tracking
agent-heart exec \
  --service github \
  --tool gh \
  --resource pulls \
  -- gh pr list --repo owner/repo

# With additional metadata
# agent-heart exec \
#   --service github \
#   --tool gh \
#   --resource pulls \
#   --session "my-automation-session" \
#   --meta env=production \
#   --meta trigger=scheduled \
#   -- gh pr list --repo owner/repo --state open --json number,title
