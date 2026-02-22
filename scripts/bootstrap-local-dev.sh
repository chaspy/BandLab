#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "[bootstrap] Starting Supabase local services..."
npx -y supabase@latest start >/tmp/bandlab-supabase-start.log 2>&1 || {
  echo "[bootstrap] supabase start failed. See /tmp/bandlab-supabase-start.log" >&2
  cat /tmp/bandlab-supabase-start.log >&2
  exit 1
}

echo "[bootstrap] Syncing .env from Supabase local status..."
ENV_OUT="$(npx -y supabase@latest status -o env)"
eval "$(printf '%s\n' "$ENV_OUT" | sed 's/^/export /')"

cat > .env <<EOF
NEXT_PUBLIC_SUPABASE_ANON_KEY=${ANON_KEY}
SUPABASE_ANON_KEY=${ANON_KEY}
SUPABASE_SERVICE_ROLE_KEY=${SERVICE_ROLE_KEY}
EOF

echo "[bootstrap] Starting MinIO..."
docker compose up -d >/tmp/bandlab-docker-compose.log 2>&1 || {
  echo "[bootstrap] docker compose up failed. See /tmp/bandlab-docker-compose.log" >&2
  cat /tmp/bandlab-docker-compose.log >&2
  exit 1
}

echo "[bootstrap] Verifying MinIO health..."
for _ in {1..20}; do
  if curl -fsS http://localhost:9000/minio/health/live >/dev/null 2>&1; then
    echo "[bootstrap] MinIO is healthy."
    exit 0
  fi
  sleep 1
done

echo "[bootstrap] MinIO health check timed out." >&2
docker compose ps >&2 || true
exit 1
