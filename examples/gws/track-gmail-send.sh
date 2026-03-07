#!/usr/bin/env bash
# Example: Track sending a Gmail message with automatic observability
#
# This wraps `gws gmail users messages send` with automatic lifecycle tracking.
# agent-pulse will:
#   1. Lock a run before the command starts
#   2. Send periodic heartbeats while it runs
#   3. Unlock the run when it finishes (with exit code, duration, and GWS metadata)
#
# Metadata is extracted automatically from the gws command structure:
#   service    -> gws-gmail
#   resource   -> users/messages
#   method     -> send
#   operation  -> write
#
# Prerequisites:
#   - agent-pulse installed: npm install -g agent-pulse
#   - agent-pulse server running: agent-pulse server start
#   - gws CLI installed and authenticated

set -euo pipefail

# Basic usage — wraps the command with full lifecycle tracking
agent-pulse gws gmail users messages send --params '{"userId":"me"}' --body '{"raw":"..."}'
