#!/bin/bash
# Milo admin — bring both demo instances up detached (survive session churn).
# Usage: scripts/admin-up.sh [start|stop|status]
set -euo pipefail
cd "$(dirname "$0")/../apps/admin"

DEV_PID=/tmp/milo-admin-dev.pid
PROD_PID=/tmp/milo-admin.pid

case "${1:-start}" in
  start)
    nohup env AUTH_MODE=dev DB_PATH=/tmp/milo-admin-test.db DATA_DIR=/tmp/milo-admin-data PORT=4103 pnpm dev >/tmp/admin-dev.log 2>&1 &
    echo $! > "$DEV_PID"
    nohup env DB_PATH=/tmp/milo-admin-test.db DATA_DIR=/tmp/milo-admin-data PORT=4100 pnpm dev >/tmp/admin-server.log 2>&1 &
    echo $! > "$PROD_PID"
    echo "up: :4100 (sign-in, pid $(cat "$PROD_PID")) · :4103 (no-login, pid $(cat "$DEV_PID"))"
    ;;
  stop)
    kill "$(cat "$DEV_PID" 2>/dev/null)" "$(cat "$PROD_PID" 2>/dev/null)" 2>/dev/null || true
    rm -f "$DEV_PID" "$PROD_PID"
    echo stopped
    ;;
  status)
    ps -p "$(cat "$DEV_PID" 2>/dev/null || echo 0)" -p "$(cat "$PROD_PID" 2>/dev/null || echo 0)" -o pid,command 2>/dev/null || echo "not running"
    ;;
  *)
    echo "usage: $0 [start|stop|status]" && exit 1 ;;
esac
