#!/usr/bin/env zsh
set -euo pipefail

ROOT="/Users/dan/pushpress/milo"
RESULTS="$ROOT/burnin-results.json"

source_env() {
  set -a
  source "$ROOT/.env"
  set +a
}

last50() {
  local f="$1"
  if [[ -f "$f" ]]; then
    tail -n 50 "$f"
  else
    echo "(log file not found)"
  fi
}

aggregate_results() {
  python3 - "$ROOT" "$RESULTS" <<'PY'
import json, glob, pathlib, sys
root = pathlib.Path(sys.argv[1])
out = pathlib.Path(sys.argv[2])
files = sorted(root.glob("burnin-*/result.json"))
data = []
for f in files:
    try:
        data.append(json.loads(f.read_text()))
    except Exception as e:
        data.append({"_read_error": str(e), "path": str(f)})
out.write_text(json.dumps(data, indent=2))
print(f"[burnin] Aggregated {len(data)} gym(s) into {out}")
PY
}

write_result() {
  # Usage: write_result <slug>
  python3 - "$1" <<'PY'
import json, os, pathlib, sys
slug = sys.argv[1]
root = pathlib.Path("/Users/dan/pushpress/milo")
dir_path = root / f"burnin-{slug}"

def b(name):
    return os.environ.get(name, "") == "true"

def n(name):
    return int(os.environ.get(name, "0") or 0)

def s(name):
    return os.environ.get(name, "")

result = {
    "slug": slug,
    "url": s("BURNIN_URL"),
    "name": s("BURNIN_NAME"),
    "city": s("BURNIN_CITY"),
    "state": s("BURNIN_STATE"),
    "intake": {
        "success": b("INTAKE_SUCCESS"),
        "exitCode": n("INTAKE_EC"),
        "gymJsonExists": b("GYM_JSON_EXISTS"),
        "assetsCount": s("ASSETS_COUNT"),
        "assetsStdoutCount": s("ASSETS_STDOUT"),
        "logLineCount": n("INTAKE_LINES"),
        "durationSec": n("INTAKE_DURATION"),
        "errorSummary": s("INTAKE_ERROR"),
    },
    "build": {
        "success": b("BUILD_SUCCESS"),
        "exitCode": n("BUILD_EC"),
        "distIndexHtmlExists": b("DIST_INDEX_EXISTS"),
        "durationSec": n("BUILD_DURATION"),
        "errorSummary": s("BUILD_ERROR"),
    },
    "publish": {
        "success": b("PUBLISH_SUCCESS"),
        "exitCode": n("PUBLISH_EC"),
        "stagingUrl": s("STAGING_URL"),
        "durationSec": n("PUBLISH_DURATION"),
        "errorSummary": s("PUBLISH_ERROR"),
    },
    "logs": {
        "intake": str(dir_path / "intake.log"),
        "build": str(dir_path / "build.log"),
        "publish": str(dir_path / "publish.log"),
    },
}
out = dir_path / "result.json"
out.write_text(json.dumps(result, indent=2))
print(f"[burnin] Wrote result.json for {slug}")
PY
}

run_gym() {
  local name="$1"
  local url="$2"
  local slug="$3"
  local city="$4"
  local state="$5"

  local dir="$ROOT/burnin-$slug"
  mkdir -p "$dir"

  local intake_log="$dir/intake.log"
  local build_log="$dir/build.log"
  local publish_log="$dir/publish.log"

  # clear env vars for this gym
  unset BURNIN_URL BURNIN_NAME BURNIN_CITY BURNIN_STATE BURNIN_SLUG
  unset INTAKE_EC INTAKE_SUCCESS INTAKE_LINES GYM_JSON_EXISTS ASSETS_COUNT ASSETS_STDOUT INTAKE_ERROR INTAKE_DURATION
  unset BUILD_EC BUILD_SUCCESS DIST_INDEX_EXISTS BUILD_ERROR BUILD_DURATION
  unset PUBLISH_EC PUBLISH_SUCCESS STAGING_URL PUBLISH_ERROR PUBLISH_DURATION

  export BURNIN_URL="$url"
  export BURNIN_NAME="$name"
  export BURNIN_CITY="$city"
  export BURNIN_STATE="$state"
  export BURNIN_SLUG="$slug"

  echo "=== Gym: $name ($slug) ==="

  # Step 1: intake
  echo "[burnin] Starting intake for $slug"
  source_env
  local intake_start=$(date +%s)
  set +e
  cd "$ROOT"
  pnpm milo intake \
    --url "$url" \
    --name "$name" \
    --city "$city" \
    --state "$state" \
    --out "burnin-$slug/intake" \
    --max-pages 10 \
    --concurrency 3 2>&1 | tee "$intake_log"
  local intake_ec=${pipestatus[1]}
  set -e
  local intake_end=$(date +%s)

  local intake_lines=0
  if [[ -f "$intake_log" ]]; then
    intake_lines=$(wc -l < "$intake_log" | tr -d ' ')
  fi
  local gym_json_exists=false
  if [[ -f "$dir/intake/gym.json" ]]; then
    gym_json_exists=true
  fi
  local assets_count="not available"
  if [[ -f "$dir/intake/crawl/gmb-assets.json" ]]; then
    assets_count=$(node -e "const d=require('$dir/intake/crawl/gmb-assets.json'); console.log((d.assets||[]).length);" 2>/dev/null || echo "parse error")
  fi
  local assets_stdout="not available"
  local out_assets
  out_assets=$(grep -E '\[intake\] Downloaded [0-9]+ GMB photos' "$intake_log" 2>/dev/null | head -1 | grep -oE '[0-9]+ GMB photos' | awk '{print $1}' || true)
  if [[ -n "$out_assets" && "$out_assets" != "$assets_count" ]]; then
    assets_stdout="$out_assets"
  fi
  local intake_error=""
  if [[ $intake_ec -ne 0 ]]; then
    intake_error=$(last50 "$intake_log")
  fi

  export INTAKE_EC=$intake_ec
  export INTAKE_SUCCESS=$([[ $intake_ec -eq 0 ]] && echo true || echo false)
  export INTAKE_LINES=$intake_lines
  export GYM_JSON_EXISTS=$gym_json_exists
  export ASSETS_COUNT="$assets_count"
  export ASSETS_STDOUT="$assets_stdout"
  export INTAKE_ERROR="$intake_error"
  export INTAKE_DURATION=$((intake_end - intake_start))

  echo "[burnin] intake exit=$intake_ec lines=$intake_lines gym.json=$gym_json_exists assets=$assets_count"

  # Step 2: build (only if intake succeeded)
  if [[ $intake_ec -eq 0 && "$gym_json_exists" == true ]]; then
    echo "[burnin] Starting build for $slug"
    rm -rf "$ROOT/apps/renderer/dist"
    source_env
    local build_start=$(date +%s)
    set +e
    cd "$ROOT"
    GYM_JSON="$dir/intake/gym.json" pnpm --filter renderer build 2>&1 | tee "$build_log"
    local build_ec=${pipestatus[1]}
    set -e
    local build_end=$(date +%s)

    if [[ -d "$ROOT/apps/renderer/dist" ]]; then
      rm -rf "$dir/dist"
      cp -R "$ROOT/apps/renderer/dist" "$dir/dist"
    fi
    local dist_index_exists=false
    if [[ -f "$dir/dist/index.html" ]]; then
      dist_index_exists=true
    fi
    local build_error=""
    if [[ $build_ec -ne 0 ]]; then
      build_error=$(last50 "$build_log")
    fi

    export BUILD_EC=$build_ec
    export BUILD_SUCCESS=$([[ $build_ec -eq 0 ]] && echo true || echo false)
    export DIST_INDEX_EXISTS=$dist_index_exists
    export BUILD_ERROR="$build_error"
    export BUILD_DURATION=$((build_end - build_start))

    echo "[burnin] build exit=$build_ec dist/index.html=$dist_index_exists"
  else
    echo "[burnin] Skipping build (intake failed)"
    : > "$build_log"
    export BUILD_EC=0
    export BUILD_SUCCESS=false
    export DIST_INDEX_EXISTS=false
    export BUILD_ERROR=""
    export BUILD_DURATION=0
  fi

  # Step 3: publish staging (only if build succeeded)
  if [[ $build_ec -eq 0 && "$dist_index_exists" == true ]]; then
    echo "[burnin] Starting publish staging for $slug"
    source_env
    local publish_start=$(date +%s)
    set +e
    cd "$ROOT"
    pnpm milo publish staging \
      --gym "$dir/intake/gym.json" \
      --dist "$dir/dist" 2>&1 | tee "$publish_log"
    local publish_ec=${pipestatus[1]}
    set -e
    local publish_end=$(date +%s)

    local staging_url=""
    staging_url=$(grep -oE 'https://[^[:space:]]+' "$publish_log" | head -1 || true)
    local publish_error=""
    if [[ $publish_ec -ne 0 ]]; then
      publish_error=$(last50 "$publish_log")
    fi

    export PUBLISH_EC=$publish_ec
    export PUBLISH_SUCCESS=$([[ $publish_ec -eq 0 ]] && echo true || echo false)
    export STAGING_URL="$staging_url"
    export PUBLISH_ERROR="$publish_error"
    export PUBLISH_DURATION=$((publish_end - publish_start))

    echo "[burnin] publish exit=$publish_ec staging_url=$staging_url"
  else
    echo "[burnin] Skipping publish (build failed or skipped)"
    : > "$publish_log"
    export PUBLISH_EC=0
    export PUBLISH_SUCCESS=false
    export STAGING_URL=""
    export PUBLISH_ERROR=""
    export PUBLISH_DURATION=0
  fi

  write_result "$slug"
  aggregate_results
}

run_all() {
  echo "[]" > "$RESULTS"
  run_gym "CrossFit Buckhead" "https://www.crossfitbuckhead.com/" "buckhead" "Atlanta" "GA"
  run_gym "CrossFit Invictus" "https://www.crossfitinvictus.com/" "invictus" "San Diego" "CA"
  run_gym "CrossFit New England" "https://www.crossfitnewengland.com/" "cfne" "Boston" "MA"
}

run_one() {
  local slug="$1"
  case "$slug" in
    buckhead)  run_gym "CrossFit Buckhead" "https://www.crossfitbuckhead.com/" "buckhead" "Atlanta" "GA" ;;
    invictus)  run_gym "CrossFit Invictus" "https://www.crossfitinvictus.com/" "invictus" "San Diego" "CA" ;;
    cfne)      run_gym "CrossFit New England" "https://www.crossfitnewengland.com/" "cfne" "Boston" "MA" ;;
    *)         echo "Unknown slug: $slug" >&2; exit 1 ;;
  esac
}

if [[ -n "${1:-}" ]]; then
  run_one "$1"
else
  run_all
fi

echo "[burnin] All gyms processed. Results written to $RESULTS"
