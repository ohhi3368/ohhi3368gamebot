#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USER_DATA_DIR="${ROOT_DIR}/user_data"
ENV_FILE="${ROOT_DIR}/.env"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-postgres}"
DB_PASSWORD="${DB_PASSWORD:-}"
DB_NAME="${DB_NAME:-postgres}"

if ! command -v psql >/dev/null 2>&1; then
  echo "[ERROR] psql command not found." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] node command not found." >&2
  exit 1
fi

if [[ ! -d "${USER_DATA_DIR}" ]]; then
  echo "[ERROR] user_data directory not found: ${USER_DATA_DIR}" >&2
  exit 1
fi

export PGPASSWORD="${DB_PASSWORD}"

psql_base_args=(
  -h "${DB_HOST}"
  -p "${DB_PORT}"
  -U "${DB_USER}"
  -d "${DB_NAME}"
  -v ON_ERROR_STOP=1
)

echo "[INFO] target DB: ${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}"

psql "${psql_base_args[@]}" -c "CREATE TABLE IF NOT EXISTS user_data (id TEXT PRIMARY KEY, jsonvalue JSONB NOT NULL);" >/dev/null

count_total=0
count_ok=0

for file in "${USER_DATA_DIR}"/*.json; do
  [[ -e "${file}" ]] || break
  count_total=$((count_total + 1))

  user_id="$(basename "${file}" .json)"
  json_compact="$(
    node -e "const fs=require('fs');const p=process.argv[1];const obj=JSON.parse(fs.readFileSync(p,'utf8'));process.stdout.write(JSON.stringify(obj));" "${file}"
  )"

  esc_user_id="$(printf "%s" "${user_id}" | sed "s/'/''/g")"
  esc_json="$(printf "%s" "${json_compact}" | sed "s/'/''/g")"

  psql "${psql_base_args[@]}" -c "INSERT INTO user_data (id, jsonvalue) VALUES ('${esc_user_id}', '${esc_json}'::jsonb) ON CONFLICT (id) DO UPDATE SET jsonvalue = EXCLUDED.jsonvalue;" >/dev/null
  count_ok=$((count_ok + 1))
  echo "[INFO] upserted: ${user_id}"
done

echo "[INFO] migration complete: ${count_ok}/${count_total}"
