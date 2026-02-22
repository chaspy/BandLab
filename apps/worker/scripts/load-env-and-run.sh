#!/usr/bin/env bash
set -euo pipefail

if [ -f "../../.env" ]; then
  set -a
  . "../../.env"
  set +a
fi

cat > .dev.vars <<EOF
SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY:-}
SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY:-}
EOF

exec "$@"
