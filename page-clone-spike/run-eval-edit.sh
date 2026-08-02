#!/usr/bin/env bash
# Run the real-LLM edit eval from the clone-engine package context.
# Usage: ./run-eval-edit.sh   (from page-clone-spike/)
set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$REPO/packages/clone-engine"
cd "$PKG"
node --env-file="$REPO/.env" node_modules/.bin/jiti "$REPO/page-clone-spike/eval-edit.ts" 2>&1
