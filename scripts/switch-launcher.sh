#!/usr/bin/env bash
# Points the repo at a redeployed BootrLauncher and prints the production (Coolify) calls for the same switch.
#
# Usage, from any directory of the checkout:
#   scripts/switch-launcher.sh <new-launcher-address> <new-start-block>
#
#   OLD_LAUNCHER / OLD_START_BLOCK   the launcher being replaced (default: the RWAGMI v3 launcher of 2026-10-29);
#                                    override only when switching away from a later launcher.
#
# What it does (docs/deploy/mainnet.md, "Launcher switch (6k opening cap)"):
#   1. validates the two arguments (0x + 40 hex, a decimal block after the old one);
#   2. rewrites the files that name the current launcher and its start block: the shared address book, the env
#      examples, the READMEs and the deploy docs (history rows, "paused" / "old launcher" lines and any
#      `BOOTR_LAUNCHERS=` entry keep the old address on purpose);
#   3. prints `git diff --stat` for what changed and every remaining mention of the old address / block, to review;
#   4. prints, WITHOUT running anything, the Coolify API calls that move production: one PATCH per variable
#      (BOOTR_LAUNCHER_ADDRESS, NEXT_PUBLIC_LAUNCHER_ADDRESS, LAUNCHER_START_BLOCK, BOOTR_LAUNCHERS) and the deploy.
#
# It never reads or prints a secret: the Coolify token stays in /root/.coolify-token on the server and the printed
# commands read it there with $(cat ...). Nothing is committed, nothing is broadcast, nothing is deployed.
set -euo pipefail

OLD_LAUNCHER="${OLD_LAUNCHER:-0xD3CE024ddC37465510E6c9a1D7942f003338B1F3}"
OLD_START_BLOCK="${OLD_START_BLOCK:-53219209}"
COOLIFY_APP_UUID="ko7sx54pwakworrqogccvbfc"
COOLIFY_API="http://127.0.0.1:8000/api/v1"

usage() {
  echo "usage: scripts/switch-launcher.sh <new-launcher-address> <new-start-block>" >&2
  echo "       (OLD_LAUNCHER / OLD_START_BLOCK override the launcher being replaced)" >&2
  exit 2
}

[ $# -eq 2 ] || usage
NEW_LAUNCHER="$1"
NEW_START_BLOCK="$2"

# --- 1. validation -------------------------------------------------------------------------------------------------
if ! [[ "$NEW_LAUNCHER" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
  echo "switch-launcher: '$NEW_LAUNCHER' is not an address (0x followed by 40 hex characters)" >&2
  exit 1
fi
if ! [[ "$NEW_START_BLOCK" =~ ^[0-9]+$ ]]; then
  echo "switch-launcher: '$NEW_START_BLOCK' is not a block number (decimal integer)" >&2
  exit 1
fi
if ! [[ "$OLD_LAUNCHER" =~ ^0x[0-9a-fA-F]{40}$ ]] || ! [[ "$OLD_START_BLOCK" =~ ^[0-9]+$ ]]; then
  echo "switch-launcher: OLD_LAUNCHER / OLD_START_BLOCK are not an address / a block number" >&2
  exit 1
fi
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
if [ "$(lower "$NEW_LAUNCHER")" = "$(lower "$OLD_LAUNCHER")" ]; then
  echo "switch-launcher: the new launcher is the old launcher ($OLD_LAUNCHER)" >&2
  exit 1
fi
if [ "$NEW_START_BLOCK" -le "$OLD_START_BLOCK" ]; then
  echo "switch-launcher: the new start block ($NEW_START_BLOCK) must be after the old one ($OLD_START_BLOCK)" >&2
  exit 1
fi
if [ "$(lower "$NEW_LAUNCHER")" = "$NEW_LAUNCHER" ]; then
  echo "switch-launcher: note: '$NEW_LAUNCHER' is all lower-case; the repo stores checksummed addresses" >&2
  echo "                 (cast to-check-sum-address $NEW_LAUNCHER)" >&2
fi

cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

# --- 2. rewrite --------------------------------------------------------------------------------------------------------
# sed -i takes a mandatory (possibly empty) suffix on macOS/BSD and an optional one on GNU.
if [ "$(uname -s)" = "Darwin" ]; then SED_I=(sed -i '' -E); else SED_I=(sed -i -E); fi

TODAY="$(date +%F)"
CHANGED=()
SKIPPED=()

# rewrite <file> <sed program>: applies the program in place, records whether the file changed.
rewrite() {
  local file="$1" program="$2" before
  if [ ! -f "$file" ]; then
    SKIPPED+=("$file (missing)")
    return 0
  fi
  before="$(mktemp)"
  cp "$file" "$before"
  "${SED_I[@]}" -e "$program" "$file"
  if cmp -s "$before" "$file"; then
    SKIPPED+=("$file (nothing to change)")
  else
    CHANGED+=("$file")
  fi
  rm -f "$before"
}

# Lines that intentionally keep the old address: multi-launcher lists (`old@block,new@block`), history rows and
# "paused" / "old launcher" / "previous launcher" / "replaced" wording. The address is only swapped when it is not
# immediately followed by '@' (a BOOTR_LAUNCHERS entry); the block only on lines that now carry the new address.
GUARD='/BOOTR_LAUNCHERS|paused|[Oo]ld launcher|[Pp]revious launcher|replaced|_pending_/!'
SWAP_ADDRESS="$GUARD s/$OLD_LAUNCHER([^@]|\$)/$NEW_LAUNCHER\\1/g"
SWAP_BLOCK_ON_NEW_LINES="/$NEW_LAUNCHER/ s/$OLD_START_BLOCK/$NEW_START_BLOCK/g"
DOCS_PROGRAM="$SWAP_ADDRESS
$SWAP_BLOCK_ON_NEW_LINES"

# Shared address book: only the `launcher:` key (the Base Sepolia guardian happens to share the old address).
rewrite packages/shared/src/addresses.ts "/launcher: '$OLD_LAUNCHER'/ s/'$OLD_LAUNCHER'/'$NEW_LAUNCHER'/
s#// Not deployed yet: filled by the cutover \\(docs/deploy/mainnet.md\\)\\.#// Launcher redeployed $TODAY at block $NEW_START_BLOCK (6k opening cap, docs/deploy/mainnet.md, Launcher switch); the rest from the 2026-10-27 cutover.#"

# Env examples: the variable lines, plus a BOOTR_LAUNCHERS list when the indexer example already carries one.
LAUNCHERS_VALUE="$OLD_LAUNCHER@$OLD_START_BLOCK,$NEW_LAUNCHER@$NEW_START_BLOCK"
rewrite .env.mainnet.example "s/^BOOTR_LAUNCHER_ADDRESS=.*/BOOTR_LAUNCHER_ADDRESS=$NEW_LAUNCHER/
s/^NEXT_PUBLIC_LAUNCHER_ADDRESS=.*/NEXT_PUBLIC_LAUNCHER_ADDRESS=$NEW_LAUNCHER/
s/^LAUNCHER_START_BLOCK=.*/LAUNCHER_START_BLOCK=$NEW_START_BLOCK/
s/^BOOTR_START_BLOCK=.*/BOOTR_START_BLOCK=$NEW_START_BLOCK/
s/^BOOTR_LAUNCHERS=.*/BOOTR_LAUNCHERS=$LAUNCHERS_VALUE/"
if ! grep -q '^BOOTR_LAUNCHERS=' .env.mainnet.example 2>/dev/null; then
  SKIPPED+=(".env.mainnet.example has no BOOTR_LAUNCHERS= line yet; add 'BOOTR_LAUNCHERS=$LAUNCHERS_VALUE' next to BOOTR_START_BLOCK once the indexer reads it")
fi

# READMEs and docs that state the current launcher.
rewrite README.md "$DOCS_PROGRAM"
rewrite packages/contracts/README.md "$DOCS_PROGRAM"
rewrite packages/contracts/src/README.md "$DOCS_PROGRAM"
rewrite apps/supervisor/README.md "$DOCS_PROGRAM
s/mainnet: \`$OLD_START_BLOCK\`, the RWAGMI-backed launcher's deploy block/mainnet: \`$NEW_START_BLOCK\`, the current launcher's deploy block/"
rewrite apps/indexer/README.md "$DOCS_PROGRAM
s/deployed at block $OLD_START_BLOCK = \`BOOTR_START_BLOCK\`/deployed at block $NEW_START_BLOCK = \`BOOTR_START_BLOCK\`/"
rewrite docs/rwagmi-migration.md "$DOCS_PROGRAM
s/^\\(deployed at block $OLD_START_BLOCK,/(deployed at block $NEW_START_BLOCK,/"

# The mainnet runbook: the status note at the top and the launcher history table; everything else there is history.
rewrite docs/deploy/mainnet.md "/^> \\*\\*Status/ { s/$OLD_LAUNCHER/$NEW_LAUNCHER/g; s/$OLD_START_BLOCK/$NEW_START_BLOCK/g; }
/^\\| v2 \\| RWAGMI v3 \\(B20\\) \\| \`$OLD_LAUNCHER\` \\| $OLD_START_BLOCK \\| current/ s/\\| current[^|]*\\|\$/| paused $TODAY |/
/^\\| v3 / s/\\| _pending_ \\| _pending_ \\| planned[^|]*\\|\$/| \`$NEW_LAUNCHER\` | $NEW_START_BLOCK | current, verify on Sourcify |/"

# --- 3. summary --------------------------------------------------------------------------------------------------------
echo "switch-launcher: $OLD_LAUNCHER@$OLD_START_BLOCK -> $NEW_LAUNCHER@$NEW_START_BLOCK"
echo
if [ ${#CHANGED[@]} -gt 0 ]; then
  echo "changed:"
  git --no-pager diff --stat -- "${CHANGED[@]}"
else
  echo "changed: nothing (already switched, or the patterns no longer match)"
fi
echo
if [ ${#SKIPPED[@]} -gt 0 ]; then
  echo "not changed:"
  printf '  %s\n' "${SKIPPED[@]}"
  echo
fi
echo "still naming the old launcher or its block (history rows, paused / old-launcher lines, BOOTR_LAUNCHERS; review):"
if ! git --no-pager grep -n -E "$OLD_LAUNCHER|$OLD_START_BLOCK" -- \
  ':!brand' ':!docs/applications' ':!packages/contracts/broadcast' ':!*.lock' | sed 's/^/  /'; then
  echo "  (none)"
fi
echo
echo "by hand, before committing:"
echo "  - docs/deploy/mainnet.md: fill in the 'Deployed' paragraph of the Launcher switch section (read-back values)"
echo "  - pnpm --filter @bootr/shared typecheck"
echo "  - git add -p && git commit   (this script commits nothing)"
echo

# --- 4. production (printed, not executed) -------------------------------------------------------------------------------
cat <<CALLS
production (Coolify application $COOLIFY_APP_UUID): run these ON THE SERVER as root, in this order, after the commit
is on main. The token is read from /root/.coolify-token by each command; do not paste it anywhere.

# variables (PATCH updates an existing variable; a variable that does not exist yet needs POST on the same path)
curl -s -X PATCH -H "Authorization: Bearer \$(cat /root/.coolify-token)" -H "Content-Type: application/json" \\
  $COOLIFY_API/applications/$COOLIFY_APP_UUID/envs \\
  -d '{"key":"BOOTR_LAUNCHER_ADDRESS","value":"$NEW_LAUNCHER","is_preview":false,"is_build_time":false}'
curl -s -X PATCH -H "Authorization: Bearer \$(cat /root/.coolify-token)" -H "Content-Type: application/json" \\
  $COOLIFY_API/applications/$COOLIFY_APP_UUID/envs \\
  -d '{"key":"NEXT_PUBLIC_LAUNCHER_ADDRESS","value":"$NEW_LAUNCHER","is_preview":false,"is_build_time":true}'
curl -s -X PATCH -H "Authorization: Bearer \$(cat /root/.coolify-token)" -H "Content-Type: application/json" \\
  $COOLIFY_API/applications/$COOLIFY_APP_UUID/envs \\
  -d '{"key":"LAUNCHER_START_BLOCK","value":"$NEW_START_BLOCK","is_preview":false,"is_build_time":false}'
# the indexer keeps the old launcher's coins (OWL) through this list, which wins over BOOTR_LAUNCHER_ADDRESS /
# BOOTR_START_BLOCK (leave those two as they are). First time: POST instead of PATCH, the variable is new.
curl -s -X PATCH -H "Authorization: Bearer \$(cat /root/.coolify-token)" -H "Content-Type: application/json" \\
  $COOLIFY_API/applications/$COOLIFY_APP_UUID/envs \\
  -d '{"key":"BOOTR_LAUNCHERS","value":"$LAUNCHERS_VALUE","is_preview":false,"is_build_time":false}'

# read back (the response lists every variable; the token is not in it)
curl -s -H "Authorization: Bearer \$(cat /root/.coolify-token)" $COOLIFY_API/applications/$COOLIFY_APP_UUID/envs \\
  | jq -r '.[] | select(.key | test("LAUNCHER|START_BLOCK")) | "\\(.key)=\\(.value)"'

# deploy (rebuilds web with the new NEXT_PUBLIC_LAUNCHER_ADDRESS, restarts indexer and supervisor)
curl -s -X POST -H "Authorization: Bearer \$(cat /root/.coolify-token)" -H "Content-Type: application/json" \\
  $COOLIFY_API/deploy -d '{"uuid":"$COOLIFY_APP_UUID","force":false}'
# then: GET $COOLIFY_API/deployments/<deployment uuid> until it is finished, and the verification list in
# docs/deploy/mainnet.md, "Launcher switch (6k opening cap)".
CALLS
