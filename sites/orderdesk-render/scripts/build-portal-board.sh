#!/usr/bin/env bash
# Re-bundle the Dealer Portal board logic after the Portal changes its scheduling code.
#   scripts/build-portal-board.sh /path/to/dealertest2
# Needs: npm i --no-save esbuild firebase react react-dom xlsx date-fns lucide-react react-router-dom (in a scratch dir)
set -euo pipefail
PORTAL="${1:?path to dealertest2 checkout}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SCRATCH="$(mktemp -d)"
( cd "$SCRATCH" && npm init -y >/dev/null && npm i --no-audit --no-fund esbuild firebase react react-dom xlsx date-fns lucide-react react-router-dom >/dev/null )
ENV='{"VITE_FIREBASE_API_KEY":"x","VITE_FIREBASE_AUTH_DOMAIN":"x.firebaseapp.com","VITE_FIREBASE_DATABASE_URL":"https://scheduling-dd672-default-rtdb.asia-southeast1.firebasedatabase.app","VITE_FIREBASE_PROJECT_ID":"x","VITE_FIREBASE_STORAGE_BUCKET":"x","VITE_FIREBASE_MESSAGING_SENDER_ID":"1","VITE_FIREBASE_APP_ID":"1:1:web:1","VITE_SHOW_FIREBASE_DATABASE_URL":"https://x.firebaseio.com"}'
NODE_PATH="$SCRATCH/node_modules" "$SCRATCH/node_modules/.bin/esbuild" "$HERE/vendor/portal/entry.ts" --bundle --platform=node --format=cjs \
  --outfile="$HERE/vendor/portal/portal-board.cjs" --alias:@="$PORTAL/src" --loader:.css=empty --minify --legal-comments=none \
  --define:import.meta.env="$ENV" --log-level=error
echo "built from $(git -C "$PORTAL" rev-parse --short HEAD) -> vendor/portal/portal-board.cjs"
git -C "$PORTAL" rev-parse HEAD > "$HERE/vendor/portal/SOURCE_COMMIT"
