#!/usr/bin/env bash
# Environment/secret management. One encrypted file, config/secrets.enc.yaml,
# holds a `dev:` and a `prod:` section; sops+age encrypts the values and leaves
# the key names in plaintext so diffs stay readable.
#
#   scripts/env.sh edit                    open the decrypted file in $EDITOR
#   scripts/env.sh print <dev|prod>        KEY=VALUE lines
#   scripts/env.sh keys  <dev|prod>        key names and set/unset, no values
#   scripts/env.sh run   <dev|prod> -- cmd run cmd with that environment
#   scripts/env.sh rekey                   re-encrypt to .sops.yaml recipients
#   scripts/env.sh diff-prod               key-level drift vs the live app
#   scripts/env.sh push-prod               apply prod section to dokku config
#   scripts/env.sh pull-prod               import live dokku config into prod
#
# Local override: for `dev` only, a gitignored .env at the repo root wins over
# the dev section, key by key. That is the escape hatch for a value you do not
# want to share — point at your own database, swap in a personal provider key —
# without touching the encrypted file. Format is KEY=VALUE, one per line;
# `export ` prefix and # comment lines are allowed, multi-line values are not.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SECRETS="$ROOT/config/secrets.enc.yaml"

DOKKU_HOST="${DOKKU_HOST:?set DOKKU_HOST to the deploy host}"
DOKKU_SSH_PORT="${DOKKU_SSH_PORT:-22}"
DOKKU_APP="${DOKKU_APP:-spawnwatcher}"

# Never written by push-prod, and ignored by pull-prod/diff-prod: DATABASE_URL
# belongs to the postgres plugin link, the rest are set by Dokku itself.
# Managing them from here would break the app on the next deploy.
UNMANAGED='^(DATABASE_URL|GIT_REV|DOKKU_.*)$'

die() { echo "error: $*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required"; }

dokku() { ssh -p "$DOKKU_SSH_PORT" "dokku@$DOKKU_HOST" "$@"; }

# Parse a .env file into a JSON object.
dotenv_json() {
  local out='{}' line key val
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"
    case "$line" in '' | '#'*) continue ;; esac
    line="${line#export }"
    case "$line" in *=*) ;; *) continue ;; esac
    key="${line%%=*}"
    val="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"
    case "$val" in
      '"'*'"') val="${val#\"}"; val="${val%\"}" ;;
      "'"*"'") val="${val#\'}"; val="${val%\'}" ;;
      *) val="${val%"${val##*[![:space:]]}"}" ;;
    esac
    out="$(printf '%s' "$out" | jq --arg k "$key" --arg v "$val" '.[$k] = $v')"
  done <"$1"
  printf '%s' "$out"
}

# Decrypted section as a JSON object, with the .env overlay applied for dev.
section_json() {
  local name="$1" json
  [ -f "$SECRETS" ] || die "missing $SECRETS"
  json="$(sops --decrypt --output-type json "$SECRETS" |
    jq --arg s "$name" 'if has($s) then .[$s] else error("no section: " + $s) end')"
  if [ "$name" = dev ] && [ -f "$ROOT/.env" ]; then
    json="$(printf '%s' "$json" |
      jq --argjson o "$(dotenv_json "$ROOT/.env")" '. * $o')"
  fi
  printf '%s' "$json"
}

# NUL-delimited KEY=VALUE pairs. Empty values are dropped so the app's own
# defaults apply instead of being overridden with an empty string.
pairs_nul() {
  jq -j 'to_entries[] | select(.value != "" and .value != null) | "\(.key)=\(.value)\u0000"'
}

cmd_edit() { need sops; sops "$SECRETS"; }

cmd_rekey() { need sops; sops updatekeys --yes "$SECRETS"; }

cmd_print() {
  need sops; need jq
  section_json "${1:?usage: print <dev|prod>}" |
    jq -r 'to_entries[] | select(.value != "") | "\(.key)=\(.value)"'
}

cmd_keys() {
  need sops; need jq
  section_json "${1:?usage: keys <dev|prod>}" |
    jq -r 'to_entries[] | "\(.key)\t\(if .value == "" then "unset" else "set" end)"'
}

cmd_run() {
  need sops; need jq
  local name="${1:?usage: run <dev|prod> -- cmd ...}"; shift
  [ "${1:-}" = "--" ] && shift
  [ $# -gt 0 ] || die "nothing to run"
  local pairs=() kv
  while IFS= read -r -d '' kv; do pairs+=("$kv"); done < <(section_json "$name" | pairs_nul)
  exec env "${pairs[@]}" "$@"
}

cmd_push_prod() {
  need sops; need jq
  local args=() skipped=() kv key
  while IFS= read -r -d '' kv; do
    key="${kv%%=*}"
    if printf '%s' "$key" | grep -Eq "$UNMANAGED"; then skipped+=("$key"); continue; fi
    args+=("$key=$(printf '%s' "${kv#*=}" | base64 | tr -d '\n')")
  done < <(section_json prod | pairs_nul)
  [ ${#args[@]} -gt 0 ] || die "prod section has no values to push"
  [ ${#skipped[@]} -eq 0 ] || echo ">> skipping dokku-owned: ${skipped[*]}" >&2
  echo ">> setting ${#args[@]} vars on $DOKKU_APP"
  # --no-restart because this runs immediately before the deploy push, which
  # restarts anyway; --encoded so values survive the remote shell verbatim.
  #
  # Output is discarded on purpose: on success `config:set` echoes the app's
  # entire config back in plaintext. In CI that would write every production
  # secret into the build log, where GitHub's masking cannot reach it (the
  # values arrive as command output, not as registered secrets). Errors still
  # surface through the exit status, and the message below reports the result.
  if dokku config:set --no-restart --encoded "$DOKKU_APP" "${args[@]}" >/dev/null 2>&1; then
    echo ">> ok"
  else
    die "config:set failed (output suppressed because it contains secrets); \
re-run scripts/env.sh push-prod locally to see it"
  fi
}

cmd_pull_prod() {
  need sops; need jq
  local live merged count
  live="$(dokku config:export --format json "$DOKKU_APP" |
    jq --arg re "$UNMANAGED" 'with_entries(select(.key | test($re) | not))')"
  count="$(printf '%s' "$live" | jq 'length')"
  [ "$count" -gt 0 ] || die "no importable vars on $DOKKU_APP"
  # Live values win; keys the file declares but the app lacks stay as empty
  # placeholders so the full surface remains visible.
  merged="$(sops --decrypt --output-type json "$SECRETS" |
    jq --argjson live "$live" '.prod + $live')"
  printf '%s' "$merged" | sops set "$SECRETS" '["prod"]' --value-stdin
  echo ">> imported $count prod vars from $DOKKU_APP"
}

cmd_diff_prod() {
  need sops; need jq
  local live file
  live="$(dokku config:export --format json "$DOKKU_APP")"
  file="$(section_json prod)"
  jq -n --argjson live "$live" --argjson file "$file" --arg re "$UNMANAGED" '
    ($live | with_entries(select(.key | test($re) | not)))  as $L |
    ($file | with_entries(select(.value != "")))            as $F |
    {
      only_in_file:  (($F | keys) - ($L | keys)),
      only_on_dokku: (($L | keys) - ($F | keys)),
      differs:       [ ($F | keys)[] as $k | select(($L | has($k)) and $L[$k] != $F[$k]) | $k ]
    }'
}

case "${1:-}" in
  edit) shift; cmd_edit "$@" ;;
  rekey) shift; cmd_rekey "$@" ;;
  print) shift; cmd_print "$@" ;;
  keys) shift; cmd_keys "$@" ;;
  run) shift; cmd_run "$@" ;;
  push-prod) shift; cmd_push_prod "$@" ;;
  pull-prod) shift; cmd_pull_prod "$@" ;;
  diff-prod) shift; cmd_diff_prod "$@" ;;
  *) sed -n '2,19p' "$0" | sed 's/^#\{1\} \{0,1\}//'; exit 1 ;;
esac
