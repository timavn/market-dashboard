#!/bin/bash
# Snapshot the whole working tree (committed, uncommitted and untracked work)
# onto refs/heads/backup/nightly without touching the checkout: no branch
# switch, no stash, no HEAD move, and the real index is only ever read. The
# snapshot is built in a throwaway index, committed with the previous backup
# and the current HEAD as parents, scanned for secrets, and pushed.
#
# Usage: nightly_backup.sh [--dry-run] [--repo DIR]
#   --dry-run  build and scan the snapshot, report what would be pushed, push nothing
#   --repo     repository to back up (default: the repository holding this script)
#
# Environment overrides (used by the test): NIGHTLY_BACKUP_REMOTE (origin),
# NIGHTLY_BACKUP_LOG, NIGHTLY_BACKUP_NOTIFY (true), NIGHTLY_BACKUP_MAX_BYTES.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
BRANCH="backup/nightly"
REMOTE="${NIGHTLY_BACKUP_REMOTE:-origin}"
LOG_FILE="${NIGHTLY_BACKUP_LOG:-${HOME}/Library/Logs/market-dashboard/nightly-backup.log}"
NOTIFY="${NIGHTLY_BACKUP_NOTIFY:-true}"
# GitHub rejects files over 100 MB; keep well clear of it.
MAX_BYTES="${NIGHTLY_BACKUP_MAX_BYTES:-52428800}"
DRY_RUN=false

# Never captured: local-only research output and files holding account details.
EXCLUDED_PATHS=(
  '.claude/settings.local.json'
  'artifacts/kalshi-line-backtest'
  'artifacts/btc-kalshi-line-backtest'
  'output/pdf'
)
# Credential-shaped files: local changes are never captured. A committed copy
# (for example .env.example) stays at its HEAD version; anything else is dropped.
CREDENTIAL_GLOBS=(
  '**/.env' '**/.env.*' '**/*.pem' '**/*.key' '**/*.p12' '**/*.pfx' '**/*.jks'
  '**/*.keystore' '**/id_rsa*' '**/id_dsa*' '**/id_ecdsa*' '**/id_ed25519*'
  '**/.netrc' '**/.npmrc' '**/.pypirc' '**/.aws/**' '**/credentials'
  '**/*credentials*.json' '**/*cookies*.json' '**/secrets.*' '**/settings.local.json'
)
# label|extended regex. Matches abort the push; the log names the file and the
# label, never the matched text. Lines containing EXAMPLE (AWS documentation
# keys) are ignored.
SECRET_PATTERNS=(
  'aws-access-key-id|(AKIA|ASIA)[A-Z2-7]{16}'
  'aws-secret-access-key|[Aa][Ww][Ss]_?[Ss][Ee][Cc][Rr][Ee][Tt]_?[Aa][Cc][Cc][Ee][Ss][Ss]_?[Kk][Ee][Yy]["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9/+]{40}'
  'private-key|-----BEGIN ([A-Z]+ )*PRIVATE KEY-----'
  'github-token|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}'
  'slack-token|xox[baprs]-[A-Za-z0-9-]{10,}'
  'google-api-key|AIza[0-9A-Za-z_-]{35}'
  'stripe-live-key|[rs]k_live_[0-9A-Za-z]{20,}'
  'anthropic-key|sk-ant-[A-Za-z0-9_-]{20,}'
  'openai-key|sk-proj-[A-Za-z0-9_-]{20,}'
)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --repo) REPO_DIR="$(cd "$2" && pwd)"; shift ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 64 ;;
  esac
  shift
done

mkdir -p "$(dirname "$LOG_FILE")"
log() {
  local line
  line="$(date '+%Y-%m-%d %H:%M:%S') [$$] $*"
  printf '%s\n' "$line" >> "$LOG_FILE"
  if [[ -t 2 || "$DRY_RUN" == "true" ]]; then printf '%s\n' "$line" >&2; fi
}
notify_failure() {
  [[ "$NOTIFY" == "true" ]] || return 0
  /usr/bin/osascript -e "display notification \"$1 See ${LOG_FILE}\" with title \"market-dashboard nightly backup failed\"" \
    >/dev/null 2>&1 || true
}
FAILED=false
fail() {
  FAILED=true
  log "FAILED: $*"
  notify_failure "$*"
  exit 1
}

WORK_DIR=""
LOCK_DIR="${HOME}/Library/Caches/market-dashboard-nightly-backup.lock"
cleanup() {
  local status=$?
  if [[ -n "$WORK_DIR" ]]; then rm -rf "$WORK_DIR"; fi
  if [[ -f "$LOCK_DIR/pid" && "$(cat "$LOCK_DIR/pid" 2>/dev/null)" == "$$" ]]; then rm -rf "$LOCK_DIR"; fi
  if [[ "$status" -ne 0 && "$FAILED" != "true" ]]; then
    log "FAILED: exited with status ${status}."
    notify_failure "Exited with status ${status}."
  fi
}
trap cleanup EXIT
trap 'fail "unexpected error at line ${LINENO} (exit $?)."' ERR

mkdir -p "$(dirname "$LOCK_DIR")"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  other_pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [[ -n "$other_pid" ]] && kill -0 "$other_pid" 2>/dev/null; then
    fail "another backup (pid ${other_pid}) is still running."
  fi
  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR"
fi
echo "$$" > "$LOCK_DIR/pid"

cd "$REPO_DIR"
# Never let a read-only git command refresh or lock the real index.
export GIT_OPTIONAL_LOCKS=0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "${REPO_DIR} is not a git work tree."
[[ "$(git rev-parse --show-toplevel)" == "$(pwd -P)" ]] || fail "${REPO_DIR} is not the repository root."

current_branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || echo '(detached)')"
case "$BRANCH" in
  main|master|"$current_branch") fail "refusing to write to ${BRANCH}." ;;
esac
head_commit="$(git rev-parse --verify --quiet HEAD^{commit} || true)"

# Previous backup tip, read from the remote so a lost local ref cannot fork the branch.
ls_status=0
remote_line="$(git ls-remote --exit-code "$REMOTE" "refs/heads/${BRANCH}" 2>>"$LOG_FILE")" || ls_status=$?
case "$ls_status" in
  0) previous_tip="${remote_line%%[[:space:]]*}" ;;
  2) previous_tip="" ;;
  *) fail "could not reach ${REMOTE} (git ls-remote exit ${ls_status})." ;;
esac
if [[ -n "$previous_tip" ]] && ! git cat-file -e "${previous_tip}^{commit}" 2>/dev/null; then
  git fetch --quiet --no-tags --no-write-fetch-head "$REMOTE" \
    "+refs/heads/${BRANCH}:refs/remotes/${REMOTE}/${BRANCH}" 2>>"$LOG_FILE" \
    || fail "could not fetch the previous backup ${previous_tip}."
fi

# Build the snapshot in a private index seeded from the real one (read-only copy).
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/market-dashboard-nightly-backup.XXXXXX")"
export GIT_INDEX_FILE="${WORK_DIR}/index"
real_index="$(git rev-parse --path-format=absolute --git-path index)"
if [[ -f "$real_index" ]]; then
  cp "$real_index" "$GIT_INDEX_FILE"
elif [[ -n "$head_commit" ]]; then
  git read-tree "$head_commit"
fi

pathspec=(.)
for path in "${EXCLUDED_PATHS[@]}"; do pathspec+=(":(exclude)${path}"); done
for glob in "${CREDENTIAL_GLOBS[@]}"; do pathspec+=(":(exclude,glob)${glob}"); done
git add -A -- "${pathspec[@]}"
git rm -r -q -f --cached --ignore-unmatch -- "${EXCLUDED_PATHS[@]}" >/dev/null

# Put one path back to its HEAD version in the private index, or drop it.
revert_to_head() {
  local path="$1" entry=""
  if [[ -n "$head_commit" ]]; then entry="$(git ls-tree --full-tree "$head_commit" -- "$path")"; fi
  if [[ -n "$entry" ]]; then
    printf '%s\n' "$entry" | git update-index --index-info
  else
    git update-index --force-remove -- "$path"
  fi
}
credential_pathspec=()
for glob in "${CREDENTIAL_GLOBS[@]}"; do credential_pathspec+=(":(glob)${glob}"); done
while IFS= read -r -d '' path; do
  revert_to_head "$path"
done < <(git ls-files -z -- "${credential_pathspec[@]}")

tree="$(git write-tree)"
base_tree="${head_commit:+$(git rev-parse "${head_commit}^{tree}")}"
base_tree="${base_tree:-$(git hash-object -t tree /dev/null)}"
oversized=0
while IFS= read -r -d '' meta && IFS= read -r -d '' path; do
  new_blob="$(printf '%s' "$meta" | awk '{print $4}')"
  [[ "$new_blob" =~ ^0+$ ]] && continue
  size="$(git cat-file -s "$new_blob" 2>/dev/null || echo 0)"
  if [[ "$size" -gt "$MAX_BYTES" ]]; then
    log "WARN: left out ${path} (${size} bytes is over the ${MAX_BYTES}-byte limit)."
    revert_to_head "$path"
    oversized=$((oversized + 1))
  fi
done < <(git diff-tree -r -z --no-renames "$base_tree" "$tree")
if [[ "$oversized" -gt 0 ]]; then tree="$(git write-tree)"; fi

if [[ -n "$previous_tip" && "$(git rev-parse "${previous_tip}^{tree}")" == "$tree" ]]; then
  log "OK: nothing changed since backup ${previous_tip:0:8}; skipped."
  exit 0
fi

# Secret scan over everything this push would newly publish: the snapshot's
# changes since the last backup (or HEAD), plus local commits not yet on the remote.
scan_base="${previous_tip:+$(git rev-parse "${previous_tip}^{tree}")}"
scan_base="${scan_base:-$base_tree}"
added_lines="${WORK_DIR}/added-lines"
{
  git diff-tree -r -p -U0 --no-color --no-ext-diff --no-textconv --no-renames "$scan_base" "$tree"
  if [[ -n "$head_commit" ]]; then
    git log -p -U0 --no-color --no-ext-diff --no-textconv --no-renames --format= \
      "$head_commit" --not --remotes="$REMOTE"
  fi
} | awk '
  /^diff --git / { header = 1; next }
  header && /^\+\+\+ / { file = substr($0, 5); sub(/^b\//, "", file); header = 0; next }
  /^@@/ { header = 0; next }
  !header && /^\+/ { print file "\t" substr($0, 2) }
' > "$added_lines"

findings="${WORK_DIR}/findings"
: > "$findings"
for entry in "${SECRET_PATTERNS[@]}"; do
  label="${entry%%|*}"
  regex="${entry#*|}"
  { grep -E -e "$regex" "$added_lines" || true; } | { grep -v 'EXAMPLE' || true; } \
    | cut -f1 | sort -u | sed "s|\$| (${label})|" >> "$findings"
done
if [[ -s "$findings" ]]; then
  while IFS= read -r finding; do log "SECRET: ${finding}"; done < "$findings"
  fail "possible secrets found; nothing was pushed. Remove them (or add the file to an exclusion) and rerun."
fi

changed_count="$(git diff-tree -r --name-only --no-renames "$scan_base" "$tree" | wc -l | tr -d ' ')"
stamp="$(date '+%Y-%m-%d %H:%M %Z')"
if [[ "$DRY_RUN" == "true" ]]; then
  log "DRY RUN: would push tree ${tree:0:8} to ${REMOTE}/${BRANCH} (${changed_count} files changed since ${previous_tip:+backup ${previous_tip:0:8}}${previous_tip:-HEAD}); secret scan clean."
  git diff-tree -r --name-status --no-renames "$scan_base" "$tree" > "${WORK_DIR}/changes"
  head -n 40 "${WORK_DIR}/changes" >&2
  exit 0
fi

parents=()
[[ -n "$previous_tip" ]] && parents+=(-p "$previous_tip")
[[ -n "$head_commit" && "$head_commit" != "$previous_tip" ]] && parents+=(-p "$head_commit")
commit="$(printf 'Nightly backup %s\n\nWorking tree of %s on branch %s at %s.\n%s files changed since the previous backup.\n' \
  "$stamp" "$(hostname -s)" "$current_branch" "${head_commit:0:8}" "$changed_count" \
  | git commit-tree "$tree" ${parents[@]+"${parents[@]}"})"

git push --quiet "$REMOTE" "${commit}:refs/heads/${BRANCH}" 2>>"$LOG_FILE" \
  || fail "git push of ${commit:0:8} to ${REMOTE}/${BRANCH} failed."
log "OK: pushed backup ${commit:0:8} to ${REMOTE}/${BRANCH} (${changed_count} files changed; branch ${current_branch} @ ${head_commit:0:8})."
