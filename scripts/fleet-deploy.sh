#!/usr/bin/env bash
#
# fleet-deploy.sh - deploy a prebuilt oracle tarball to ONE serving host and
# prove the new build is actually LIVE.
#
# Why this exists
# ---------------
# The historical "deploy" was: scp a tarball, `npm install` it, walk away.
# `npm install` changes files on disk, but the running `node` process keeps
# executing the OLD in-memory build until it is restarted. So a "deploy" could
# silently be a no-op: the disk says v2, the live service is still v1.
#
# This script makes deploy == restart == verify, atomically:
#   1. it installs the tarball,
#   2. it restarts the systemd --user serve unit(s),
#   3. it hits /health and asserts the LIVE build.commit matches what was
#      shipped AND that uptimeSeconds is tiny (proving a real restart, not a
#      stale process). If either check fails, the script exits non-zero.
#
# It supports both real fleet layouts, via flags (nothing is baked in):
#   * templated multi-lane user units, e.g. oracle-serve@9473.service
#   * a single global user unit,       e.g. oracle-serve.service
#
# No hostnames, IPs, tokens, or box identities live in this file. Everything is
# a flag. Assumes passwordless SSH (via your ssh config) to the target host.

set -euo pipefail

# --------------------------------------------------------------------------- #
# Defaults (all overridable by flags). No identities here.
# --------------------------------------------------------------------------- #
HOST=""
TARBALL=""
# These tildes are intentionally literal: they are passed to the remote and
# expanded against the REMOTE $HOME by expand_tilde(), never the local one.
# shellcheck disable=SC2088
NPM_PREFIX="~/.local"        # remote npm --global --prefix target
# shellcheck disable=SC2088
NODE_BIN="~/opt/node/bin"    # remote node/npm live here; NOT on the ssh PATH
TOKEN_FILE=""                # remote path holding the /health bearer token
EXPECTED_COMMIT=""           # if empty, derived from the tarball's provenance
ARCHIVE_PREFIX=""            # if empty, derived from the tarball's package name
REMOTE_STAGE_DIR="/tmp"      # where the tarball lands before install
JOURNAL_WINDOW="-6 hours"    # journalctl --since window for the idle guard
RESTART_SLEEP="2"            # seconds to wait after restart before is-active
MAX_UPTIME="120"             # uptimeSeconds must be below this to prove restart
DRY_RUN=""
SKIP_IDLE=""

declare -a SERVICES=()
declare -a HEALTH_PORTS=()

SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15)
SCP=(scp -o BatchMode=yes -o ConnectTimeout=15)

PROG="$(basename "$0")"

# --------------------------------------------------------------------------- #
# Logging helpers
# --------------------------------------------------------------------------- #
info() { printf '[deploy] %s\n' "$*"; }
warn() { printf '[deploy] WARNING: %s\n' "$*" >&2; }
fail() { printf '[deploy] ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<EOF
$PROG - deploy a prebuilt oracle tarball to one serving host and verify it went live.

Deploy == install + restart + verify. The verify step reads /health after the
restart and asserts the live build.commit matches the shipped commit AND that
uptimeSeconds is small, which makes a silent no-op deploy impossible.

USAGE:
  $PROG --host <ssh-host> --tarball <path.tgz> \\
        --service <unit> [--service <unit> ...] \\
        --health <port> [--health <port> ...] [options]

REQUIRED:
  --host <ssh-host>        SSH destination (uses your ~/.ssh/config). Assumes
                           passwordless SSH + passwordless sudo already set up.
  --tarball <path.tgz>     Local npm-pack tarball to ship (.tgz / .tar.gz).
  --service <unit>         systemd --user unit to restart. Repeatable.
  --health <port>          Local (remote-side) TCP port to hit
                           http://127.0.0.1:<port>/health for verification.
                           Repeatable. At least one is required.

OPTIONS:
  --npm-prefix <path>      Remote npm --global --prefix.   (default: $NPM_PREFIX)
  --node-bin <path>        Remote dir holding node/npm; prepended to PATH for
                           the install because the non-login ssh shell has no
                           node on PATH.                    (default: $NODE_BIN)
  --token-file <path>      Remote file with the /health bearer token. Read ON
                           the remote and never printed. If omitted, /health is
                           still attempted unauthenticated.
  --expected-commit <sha>  Commit that MUST be live after restart. If omitted,
                           it is read from dist/build-provenance.json inside the
                           tarball. Full or short sha; matched by prefix.
  --archive-prefix <name>  Base name for the durable ~/<prefix>-<ver>-<sha>.tgz
                           archive. Defaults to the tarball's own package name.
  --remote-stage-dir <dir> Remote dir to scp the tarball into.  (default: $REMOTE_STAGE_DIR)
  --since <window>         journalctl --since window for the idle guard.
                                                            (default: "$JOURNAL_WINDOW")
  --restart-sleep <sec>    Pause after restart before is-active.  (default: $RESTART_SLEEP)
  --max-uptime <sec>       Max uptimeSeconds accepted as "freshly restarted".
                                                            (default: $MAX_UPTIME)
  --skip-idle-check        Do NOT refuse to restart a lane with an in-flight run.
  --dry-run                Print every remote command that WOULD run; change nothing.
  -h, --help               Show this help.

EXAMPLES:
  # Multi-lane templated units (two lanes on one host):
  $PROG \\
    --host my-serve-host \\
    --tarball ./steipete-oracle-0.15.0.tgz \\
    --service oracle-serve@9473.service --health 9473 \\
    --service oracle-serve@9474.service --health 9474 \\
    --token-file ~/.config/oracle/serve-token \\
    --expected-commit 1db1ad78

  # Single global install (one unit, one port):
  $PROG \\
    --host my-serve-host \\
    --tarball ./steipete-oracle-0.15.0.tgz \\
    --npm-prefix ~/.local \\
    --service oracle-serve.service --health 9473 \\
    --token-file ~/.config/oracle/serve-token
EOF
}

# --------------------------------------------------------------------------- #
# Argument parsing (supports --flag value and --flag=value)
# --------------------------------------------------------------------------- #
while [ $# -gt 0 ]; do
  # Normalize --flag=value into "--flag" "value".
  case "$1" in
    --*=*)
      __key="${1%%=*}"
      __val="${1#*=}"
      shift
      set -- "$__key" "$__val" "$@"
      ;;
  esac
  case "$1" in
    --host) HOST="${2:?"--host needs a value"}"; shift 2 ;;
    --tarball) TARBALL="${2:?"--tarball needs a value"}"; shift 2 ;;
    --npm-prefix) NPM_PREFIX="${2:?"--npm-prefix needs a value"}"; shift 2 ;;
    --node-bin) NODE_BIN="${2:?"--node-bin needs a value"}"; shift 2 ;;
    --service) SERVICES+=("${2:?"--service needs a value"}"); shift 2 ;;
    --health) HEALTH_PORTS+=("${2:?"--health needs a value"}"); shift 2 ;;
    --token-file) TOKEN_FILE="${2:?"--token-file needs a value"}"; shift 2 ;;
    --expected-commit) EXPECTED_COMMIT="${2:?"--expected-commit needs a value"}"; shift 2 ;;
    --archive-prefix) ARCHIVE_PREFIX="${2:?"--archive-prefix needs a value"}"; shift 2 ;;
    --remote-stage-dir) REMOTE_STAGE_DIR="${2:?"--remote-stage-dir needs a value"}"; shift 2 ;;
    --since) JOURNAL_WINDOW="${2:?"--since needs a value"}"; shift 2 ;;
    --restart-sleep) RESTART_SLEEP="${2:?"--restart-sleep needs a value"}"; shift 2 ;;
    --max-uptime) MAX_UPTIME="${2:?"--max-uptime needs a value"}"; shift 2 ;;
    --skip-idle-check) SKIP_IDLE="1"; shift ;;
    --dry-run) DRY_RUN="1"; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; break ;;
    -*) fail "unknown flag: $1 (try --help)" ;;
    *) fail "unexpected argument: $1 (try --help)" ;;
  esac
done

# --------------------------------------------------------------------------- #
# Validate inputs
# --------------------------------------------------------------------------- #
[ -n "$HOST" ] || fail "--host is required (try --help)"
[ -n "$TARBALL" ] || fail "--tarball is required (try --help)"
[ -f "$TARBALL" ] || fail "tarball not found: $TARBALL"
case "$TARBALL" in
  *.tgz|*.tar.gz) : ;;
  *) fail "tarball must be a .tgz / .tar.gz: $TARBALL" ;;
esac
[ "${#SERVICES[@]}" -ge 1 ] || fail "at least one --service is required (try --help)"
[ "${#HEALTH_PORTS[@]}" -ge 1 ] || fail "at least one --health port is required; verification is mandatory (try --help)"

for __p in "${HEALTH_PORTS[@]}"; do
  case "$__p" in
    ''|*[!0-9]*) fail "--health port must be numeric: $__p" ;;
  esac
done
case "$RESTART_SLEEP" in ''|*[!0-9]*) fail "--restart-sleep must be numeric: $RESTART_SLEEP" ;; esac
case "$MAX_UPTIME" in ''|*[!0-9]*) fail "--max-uptime must be numeric: $MAX_UPTIME" ;; esac

# --------------------------------------------------------------------------- #
# Preflight: learn the version + commit shipped inside the tarball, locally.
# --------------------------------------------------------------------------- #
TMPD="$(mktemp -d "${TMPDIR:-/tmp}/fleet-deploy.XXXXXX")"
cleanup() { rm -rf "$TMPD"; }
trap cleanup EXIT

# package.json always exists in an npm-pack tarball; provenance may not.
if ! tar -xzf "$TARBALL" -C "$TMPD" package/package.json 2>/dev/null; then
  fail "could not read package/package.json from tarball (is it an npm-pack tarball?): $TARBALL"
fi
tar -xzf "$TARBALL" -C "$TMPD" package/dist/build-provenance.json 2>/dev/null || true

PKG_JSON="$TMPD/package/package.json"
PROV_JSON="$TMPD/package/dist/build-provenance.json"

# Minimal JSON field extraction (compact npm-pack JSON, one field per key).
json_str() { grep -oP "\"$2\"\\s*:\\s*\"\\K[^\"]+" "$1" 2>/dev/null | head -n1 || true; }

RAW_NAME="$(json_str "$PKG_JSON" name)"
PKG_VERSION="$(json_str "$PKG_JSON" version)"
[ -n "$RAW_NAME" ] || fail "could not read package name from tarball"
[ -n "$PKG_VERSION" ] || fail "could not read package version from tarball"

SHIP_COMMIT=""
SHIP_SHORT=""
if [ -f "$PROV_JSON" ]; then
  SHIP_COMMIT="$(grep -oP '"commit"\s*:\s*"\K[0-9a-f]+' "$PROV_JSON" 2>/dev/null | head -n1 || true)"
  SHIP_SHORT="$(grep -oP '"commit_short"\s*:\s*"\K[0-9a-f]+' "$PROV_JSON" 2>/dev/null | head -n1 || true)"
fi

# Resolve the commit we will demand to be live after the restart.
if [ -z "$EXPECTED_COMMIT" ]; then
  if [ -n "$SHIP_COMMIT" ]; then
    EXPECTED_COMMIT="$SHIP_COMMIT"
  elif [ -n "$SHIP_SHORT" ]; then
    EXPECTED_COMMIT="$SHIP_SHORT"
  else
    fail "cannot determine expected commit: no --expected-commit and no usable commit in dist/build-provenance.json (pass --expected-commit)"
  fi
fi

# Short sha used purely for the durable archive filename.
SHORT_SHA="$SHIP_SHORT"
[ -n "$SHORT_SHA" ] && [ -n "$SHIP_COMMIT" ] && SHORT_SHA="${SHIP_COMMIT:0:12}"
[ -n "$SHORT_SHA" ] || SHORT_SHA="${EXPECTED_COMMIT:0:12}"
[ -n "$SHORT_SHA" ] || SHORT_SHA="nocommit"

# Derive the durable archive base name from the package name if not overridden.
# e.g. "@steipete/oracle" -> "steipete-oracle" (matches npm-pack naming).
if [ -z "$ARCHIVE_PREFIX" ]; then
  ARCHIVE_PREFIX="${RAW_NAME#@}"
  ARCHIVE_PREFIX="${ARCHIVE_PREFIX//\//-}"
fi

ARCHIVE_NAME="${ARCHIVE_PREFIX}-${PKG_VERSION}-${SHORT_SHA}.tgz"
STAGE_PATH="${REMOTE_STAGE_DIR%/}/oracle-deploy-${SHORT_SHA}.tgz"
# Literal tilde on purpose: expanded against the REMOTE $HOME by expand_tilde().
# shellcheck disable=SC2088
INSTALL_TARBALL="~/${ARCHIVE_NAME}"

# --------------------------------------------------------------------------- #
# Deploy plan (one screen, no secrets)
# --------------------------------------------------------------------------- #
info "Deploy plan"
info "  host            : $HOST"
info "  tarball         : $TARBALL"
info "  package         : $RAW_NAME@$PKG_VERSION"
info "  shipped commit  : ${SHIP_COMMIT:-${SHIP_SHORT:-<none>}}"
info "  expected commit : $EXPECTED_COMMIT"
info "  remote archive  : ~/$ARCHIVE_NAME"
info "  npm prefix      : $NPM_PREFIX"
info "  node bin (PATH) : $NODE_BIN"
info "  services        : ${SERVICES[*]}"
info "  health ports    : ${HEALTH_PORTS[*]}"
info "  token file      : ${TOKEN_FILE:-<none> (unauthenticated /health)}"
info "  idle guard      : $([ -n "$SKIP_IDLE" ] && echo "DISABLED (--skip-idle-check)" || echo "on (window: $JOURNAL_WINDOW)")"
info "  max uptime      : ${MAX_UPTIME}s"
[ -n "$DRY_RUN" ] && info "  mode            : DRY RUN (no changes)"

# --------------------------------------------------------------------------- #
# Remote helpers
# --------------------------------------------------------------------------- #

# Show the exact remote invocation without running it.
dry_show() {
  printf '  [dry-run] ssh %s bash -s --' "$HOST"
  local a
  for a in "$@"; do printf ' %q' "$a"; done
  printf '\n'
}

# ssh_pipe <script> [args...] : stream <script> to `bash -s` on the remote,
# passing args as $1..$n. Args are %q-quoted so values with spaces (e.g. the
# journal window "-6 hours") survive the remote shell re-parse.
ssh_pipe() {
  local script="$1"; shift
  local argv="" a
  for a in "$@"; do
    argv+=" $(printf '%q' "$a")"
  done
  printf '%s\n' "$script" | "${SSH[@]}" "$HOST" "bash -s --${argv}"
}

# run_step <label> <script> [args...] : side-effect remote step honoring --dry-run.
run_step() {
  local label="$1" script="$2"; shift 2
  info "$label"
  if [ -n "$DRY_RUN" ]; then
    dry_show "$@"
    return 0
  fi
  ssh_pipe "$script" "$@"
}

# --------------------------------------------------------------------------- #
# Remote scripts (quoted heredocs: interpreted entirely on the remote host).
# --------------------------------------------------------------------------- #

REMOTE_ARCHIVE_SCRIPT="$(cat <<'REMOTE'
set -euo pipefail
src="$1"; dest_name="$2"
[ -f "$src" ] || { echo "staged tarball missing on remote: $src" >&2; exit 1; }
cp -f "$src" "$HOME/$dest_name"
printf 'archived %s (%s bytes)\n' "$HOME/$dest_name" "$(wc -c < "$HOME/$dest_name" | tr -d ' ')"
REMOTE
)"

REMOTE_IDLE_SCRIPT="$(cat <<'REMOTE'
set -euo pipefail
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
window="$1"; shift
busy=0
for unit in "$@"; do
  journal="$(journalctl --user -u "$unit" --since "$window" --no-pager 2>/dev/null || true)"
  last="$(grep -oP 'Accepted run \K[a-f0-9-]+' <<<"$journal" | tail -n1 || true)"
  # Do not pipe journalctl directly into grep -q under pipefail: grep exits as
  # soon as it matches, journalctl receives SIGPIPE, and a completed run is
  # then misclassified as busy.
  if [ -n "$last" ] && ! grep -qE "Run $last (completed|failed)" <<<"$journal"; then
    echo "BUSY $unit (in-flight run $last has no completed/failed record)"
    busy=1
  else
    echo "IDLE $unit${last:+ (last accepted run $last is done)}"
  fi
done
[ "$busy" -eq 0 ]
REMOTE
)"

REMOTE_INSTALL_SCRIPT="$(cat <<'REMOTE'
set -euo pipefail
prefix="$1"; node_bin="$2"; tarball="$3"
expand_tilde() { case "$1" in "~/"*) printf '%s/%s' "$HOME" "${1#\~/}" ;; *) printf '%s' "$1" ;; esac; }
prefix="$(expand_tilde "$prefix")"
node_bin="$(expand_tilde "$node_bin")"
tarball="$(expand_tilde "$tarball")"
export PATH="$node_bin:$PATH"
if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found after prepending $node_bin to PATH" >&2
  exit 1
fi
[ -f "$tarball" ] || { echo "install tarball missing on remote: $tarball" >&2; exit 1; }
echo "using node=$(command -v node 2>/dev/null || echo none) npm=$(command -v npm)"
npm install --global --prefix "$prefix" "$tarball"
echo "install ok: $tarball -> $prefix"
REMOTE
)"

REMOTE_RESTART_SCRIPT="$(cat <<'REMOTE'
set -euo pipefail
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
sleep_s="$1"; shift
rc=0
for unit in "$@"; do
  echo "restarting $unit"
  systemctl --user restart "$unit"
  sleep "$sleep_s"
  state="$(systemctl --user is-active "$unit" 2>/dev/null || true)"
  echo "  $unit is-active=$state"
  if [ "$state" != "active" ]; then
    echo "  ERROR: $unit is not active after restart (state=$state)" >&2
    rc=1
  fi
done
exit "$rc"
REMOTE
)"

# Emits: <health-json-body>\n<http_code>  (or "TOKENFILE_UNREADABLE").
# The bearer token is read on the remote and fed to curl via a stdin config
# file (-K -) so it never appears in argv / the process list, and is never
# echoed. The JSON body itself carries no token.
REMOTE_HEALTH_SCRIPT="$(cat <<'REMOTE'
set -euo pipefail
port="$1"; token_file="${2:-}"
expand_tilde() { case "$1" in "~/"*) printf '%s/%s' "$HOME" "${1#\~/}" ;; *) printf '%s' "$1" ;; esac; }
url="http://127.0.0.1:${port}/health"
if [ -n "$token_file" ]; then
  token_file="$(expand_tilde "$token_file")"
  if [ ! -r "$token_file" ]; then
    echo "TOKENFILE_UNREADABLE"
    exit 0
  fi
  token="$(cat "$token_file")"
  if ! printf 'header = "Authorization: Bearer %s"\n' "$token" \
      | curl -sS -m 5 -w $'\n%{http_code}' -K - "$url" 2>/dev/null; then
    printf '\n000'
  fi
else
  if ! curl -sS -m 5 -w $'\n%{http_code}' "$url" 2>/dev/null; then
    printf '\n000'
  fi
fi
REMOTE
)"

# --------------------------------------------------------------------------- #
# Local commit-match helper (prefix match either direction: short vs full).
# --------------------------------------------------------------------------- #
commit_matches() {
  local expected="$1" full="$2" short="$3" c
  [ -n "$expected" ] || return 1
  for c in "$full" "$short"; do
    [ -n "$c" ] || continue
    case "$c" in "$expected"*) return 0 ;; esac
    case "$expected" in "$c"*) return 0 ;; esac
  done
  return 1
}

# --------------------------------------------------------------------------- #
# 1) Stage: scp tarball to a remote temp path, then copy to the durable archive.
# --------------------------------------------------------------------------- #
info "Stage: shipping tarball to $HOST:$STAGE_PATH"
if [ -n "$DRY_RUN" ]; then
  printf '  [dry-run] scp %q %s:%q\n' "$TARBALL" "$HOST" "$STAGE_PATH"
else
  "${SCP[@]}" "$TARBALL" "$HOST:$STAGE_PATH" || fail "scp failed"
fi
run_step "Stage: copying to durable ~/$ARCHIVE_NAME" \
  "$REMOTE_ARCHIVE_SCRIPT" "$STAGE_PATH" "$ARCHIVE_NAME" \
  || fail "could not archive tarball on remote"

# --------------------------------------------------------------------------- #
# 2) Idle guard: refuse to restart a lane with an in-flight run.
# --------------------------------------------------------------------------- #
if [ -n "$SKIP_IDLE" ]; then
  warn "idle guard disabled (--skip-idle-check); restarting even if a run is in flight"
else
  if ! run_step "Idle guard: checking for in-flight runs" \
      "$REMOTE_IDLE_SCRIPT" "$JOURNAL_WINDOW" "${SERVICES[@]}"; then
    fail "one or more services are BUSY (in-flight run). Retry when idle, or pass --skip-idle-check to override."
  fi
fi

# --------------------------------------------------------------------------- #
# 3) Install (aborts before any restart if the install fails).
# --------------------------------------------------------------------------- #
if ! run_step "Install: npm install --global on remote" \
    "$REMOTE_INSTALL_SCRIPT" "$NPM_PREFIX" "$NODE_BIN" "$INSTALL_TARBALL"; then
  fail "remote npm install failed; NOT restarting any service"
fi

# --------------------------------------------------------------------------- #
# 4) Restart + is-active.
# --------------------------------------------------------------------------- #
if ! run_step "Restart: systemctl --user restart + is-active" \
    "$REMOTE_RESTART_SCRIPT" "$RESTART_SLEEP" "${SERVICES[@]}"; then
  fail "one or more services failed to come back active after restart"
fi

# --------------------------------------------------------------------------- #
# 5) Verify (the anti-no-op gate): live commit must match, uptime must be tiny.
# --------------------------------------------------------------------------- #
info "Verify: asserting live build.commit + fresh uptime on each health port"

declare -a SUMMARY=()
OVERALL_FAIL=0

for port in "${HEALTH_PORTS[@]}"; do
  if [ -n "$DRY_RUN" ]; then
    info "  port $port: would GET http://127.0.0.1:$port/health and assert commit==$EXPECTED_COMMIT, uptime<$MAX_UPTIME"
    dry_show "$port" "$TOKEN_FILE"
    SUMMARY+=("SKIP  port $port  (dry-run)")
    continue
  fi

  resp="$(ssh_pipe "$REMOTE_HEALTH_SCRIPT" "$port" "$TOKEN_FILE" || true)"

  status="PASS"
  reason=""
  live_commit=""
  live_short=""
  live_uptime=""

  if printf '%s' "$resp" | grep -q 'TOKENFILE_UNREADABLE'; then
    status="FAIL"
    reason="remote token file unreadable: ${TOKEN_FILE}"
  else
    http_code="$(printf '%s' "$resp" | tail -n1)"
    body_json="$(printf '%s' "$resp" | sed '$d')"
    live_commit="$(printf '%s' "$body_json" | grep -oP '"commit"\s*:\s*"\K[0-9a-f]+' | head -n1 || true)"
    live_short="$(printf '%s' "$body_json" | grep -oP '"commit_short"\s*:\s*"\K[0-9a-f]+' | head -n1 || true)"
    live_uptime="$(printf '%s' "$body_json" | grep -oP '"uptimeSeconds"\s*:\s*\K[0-9]+' | head -n1 || true)"

    if [ "$http_code" = "401" ]; then
      status="FAIL"
      reason="/health returned 401; pass --token-file with a valid bearer token to verify the live build"
    elif [ "$http_code" != "200" ] && [ "$http_code" != "409" ]; then
      status="FAIL"
      reason="/health unreachable or unexpected (HTTP ${http_code:-none}); service may not be listening on $port"
    elif [ -z "$live_commit" ] && [ -z "$live_short" ]; then
      status="FAIL"
      reason="could not read build.commit from /health response"
    elif ! commit_matches "$EXPECTED_COMMIT" "$live_commit" "$live_short"; then
      status="FAIL"
      reason="live commit ${live_commit:-${live_short}} != expected ${EXPECTED_COMMIT} -> DEPLOY DID NOT GO LIVE"
    elif [ -z "$live_uptime" ]; then
      status="FAIL"
      reason="uptimeSeconds missing from /health; cannot prove the process restarted"
    elif [ "$live_uptime" -ge "$MAX_UPTIME" ]; then
      status="FAIL"
      reason="uptimeSeconds=${live_uptime} >= ${MAX_UPTIME} -> STALE process, restart did not take effect"
    fi
  fi

  if [ "$status" = "PASS" ]; then
    info "  port $port: PASS  commit=${live_commit:-$live_short} uptime=${live_uptime}s"
    SUMMARY+=("PASS  port $port  commit=${live_commit:-$live_short} uptime=${live_uptime}s")
  else
    warn "  port $port: FAIL  $reason"
    SUMMARY+=("FAIL  port $port  ${reason}")
    OVERALL_FAIL=1
  fi
done

# --------------------------------------------------------------------------- #
# 6) Summary
# --------------------------------------------------------------------------- #
printf '\n'
info "==== Deploy summary: $HOST ===="
info "  expected commit : $EXPECTED_COMMIT"
info "  services        : ${SERVICES[*]}"
for line in "${SUMMARY[@]}"; do
  info "  $line"
done

if [ -n "$DRY_RUN" ]; then
  info "DRY RUN complete (no changes were made)."
  exit 0
fi

if [ "$OVERALL_FAIL" -ne 0 ]; then
  fail "deploy verification FAILED: at least one lane is not running the expected build. Investigate before trusting this host."
fi

info "SUCCESS: all lanes are live on $EXPECTED_COMMIT with fresh uptime."
