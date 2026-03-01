#!/usr/bin/env bash

set -euo pipefail

APP_DB_USER=""
APP_DB_PASS=""
DB_NAME=""
OS_CHOICE=""

ADMIN_DB_USER="postgres"
ADMIN_DB_HOST="localhost"
ADMIN_DB_PORT="5432"
ADMIN_DB_PASS=""
ADMIN_MODE="direct"

log() {
  printf '[INFO] %s\n' "$1"
}

warn() {
  printf '[WARN] %s\n' "$1" >&2
}

err() {
  printf '[ERROR] %s\n' "$1" >&2
}

prompt_os() {
  printf '1. Windows\n'
  printf '2. Linux\n'
  read -r -p 'Select operating system (1/2): ' choice

  case "$choice" in
    1) OS_CHOICE="windows" ;;
    2) OS_CHOICE="linux" ;;
    *)
      err 'Invalid selection. Enter 1 or 2.'
      exit 1
      ;;
  esac
}

prompt_app_credentials() {
  read -r -p 'Enter PostgreSQL username: ' APP_DB_USER
  if [[ -z "$APP_DB_USER" ]]; then
    err 'Username cannot be empty.'
    exit 1
  fi

  read -r -s -p 'Enter PostgreSQL password: ' APP_DB_PASS
  printf '\n'
  if [[ -z "$APP_DB_PASS" ]]; then
    err 'Password cannot be empty.'
    exit 1
  fi
}

is_postgres_installed() {
  command -v psql >/dev/null 2>&1
}

install_postgres_windows() {
  if command -v winget >/dev/null 2>&1; then
    log 'Installing PostgreSQL via winget.'
    winget install --id PostgreSQL.PostgreSQL --accept-source-agreements --accept-package-agreements
    return
  fi

  if command -v choco >/dev/null 2>&1; then
    log 'Installing PostgreSQL via choco.'
    choco install postgresql -y
    return
  fi

  if command -v scoop >/dev/null 2>&1; then
    log 'Installing PostgreSQL via scoop.'
    scoop install postgresql
    return
  fi

  err 'No supported Windows package manager found (winget/choco/scoop).'
  err 'Install PostgreSQL manually and run this script again.'
  exit 1
}

install_postgres_linux() {
  if command -v apt-get >/dev/null 2>&1; then
    log 'Installing PostgreSQL via apt-get.'
    sudo apt-get update
    sudo apt-get install -y postgresql postgresql-contrib
    return
  fi

  if command -v dnf >/dev/null 2>&1; then
    log 'Installing PostgreSQL via dnf.'
    sudo dnf install -y postgresql-server postgresql-contrib
    return
  fi

  if command -v yum >/dev/null 2>&1; then
    log 'Installing PostgreSQL via yum.'
    sudo yum install -y postgresql-server postgresql-contrib
    return
  fi

  if command -v pacman >/dev/null 2>&1; then
    log 'Installing PostgreSQL via pacman.'
    sudo pacman -Sy --noconfirm postgresql
    return
  fi

  if command -v zypper >/dev/null 2>&1; then
    log 'Installing PostgreSQL via zypper.'
    sudo zypper --non-interactive install postgresql-server postgresql-contrib
    return
  fi

  err 'No supported Linux package manager found.'
  err 'Install PostgreSQL manually and run this script again.'
  exit 1
}

maybe_install_postgres() {
  if is_postgres_installed; then
    log 'PostgreSQL is already installed.'
    prompt_app_credentials
    return
  fi

  warn 'PostgreSQL is not installed.'
  read -r -p 'Do you want to install it? (y/n): ' install_answer

  case "${install_answer,,}" in
    y|yes)
      prompt_app_credentials
      if [[ "$OS_CHOICE" == "windows" ]]; then
        install_postgres_windows
      else
        install_postgres_linux
      fi
      ;;
    n|no)
      err 'PostgreSQL is required. Exiting script.'
      exit 1
      ;;
    *)
      err 'Please enter y or n.'
      exit 1
      ;;
  esac

  if ! is_postgres_installed; then
    err 'psql command is still not found after installation. Check PATH.'
    exit 1
  fi
}

ensure_service_running_linux() {
  if [[ "$OS_CHOICE" != "linux" ]]; then
    return
  fi

  if command -v systemctl >/dev/null 2>&1; then
    sudo systemctl enable --now postgresql || true
    sudo systemctl start postgresql || true
  fi
}

admin_psql() {
  local sql="$1"

  if [[ "$ADMIN_MODE" == "sudo_i" ]]; then
    sudo -i -u postgres psql -d postgres -tAc "$sql"
    return
  fi

  PGPASSWORD="$ADMIN_DB_PASS" psql -h "$ADMIN_DB_HOST" -p "$ADMIN_DB_PORT" -U "$ADMIN_DB_USER" -d postgres -tAc "$sql"
}

configure_admin_access() {
  if [[ "$OS_CHOICE" == "linux" ]] && command -v sudo >/dev/null 2>&1; then
    ADMIN_MODE="sudo_i"
    if admin_psql 'SELECT 1;' >/dev/null 2>&1; then
      log 'Using admin connection via sudo -i -u postgres.'
      return
    fi
    warn 'sudo -i -u postgres connection failed. Falling back to direct admin login.'
    ADMIN_MODE="direct"
  fi

  read -r -p 'Admin (PostgreSQL superuser) username [postgres]: ' in_admin_user
  if [[ -n "$in_admin_user" ]]; then
    ADMIN_DB_USER="$in_admin_user"
  fi

  read -r -s -p 'Admin password (press Enter if none): ' ADMIN_DB_PASS
  printf '\n'

  if admin_psql 'SELECT 1;' >/dev/null 2>&1; then
    return
  fi

  if [[ "$OS_CHOICE" == "linux" ]] && command -v sudo >/dev/null 2>&1; then
    ADMIN_MODE="sudo_i"
    if admin_psql 'SELECT 1;' >/dev/null 2>&1; then
      log 'Using admin connection via sudo -i -u postgres.'
      return
    fi
  fi

  err 'Failed to connect to PostgreSQL with admin credentials.'
  err 'Check admin username/password or pg_hba.conf settings.'
  exit 1
}

sql_escape() {
  printf "%s" "$1" | sed "s/'/''/g"
}

ensure_role_exists() {
  local esc_user
  local esc_pass
  local role_exists

  esc_user="$(sql_escape "$APP_DB_USER")"
  esc_pass="$(sql_escape "$APP_DB_PASS")"

  role_exists="$(admin_psql "SELECT 1 FROM pg_roles WHERE rolname='${esc_user}';" | tr -d '[:space:]')"

  if [[ "$role_exists" == "1" ]]; then
    log "User '${APP_DB_USER}' already exists. Updating password."
    admin_psql "ALTER ROLE \"$APP_DB_USER\" WITH LOGIN PASSWORD '${esc_pass}';" >/dev/null
  else
    log "Creating user '${APP_DB_USER}'."
    admin_psql "CREATE ROLE \"$APP_DB_USER\" WITH LOGIN PASSWORD '${esc_pass}';" >/dev/null
  admin_psql "GRANT ALL PRIVILEGES ON DATABASE \"$DB_NAME\" TO \"$APP_DB_USER\";"
  fi
}

prompt_database_name() {
  read -r -p 'Enter database name to use: ' DB_NAME
  if [[ -z "$DB_NAME" ]]; then
    err 'Database name cannot be empty.'
    exit 1
  fi
}

ensure_database_and_privileges() {
  local esc_db
  local db_exists
  local has_connect
  local has_create

  esc_db="$(sql_escape "$DB_NAME")"
  db_exists="$(admin_psql "SELECT 1 FROM pg_database WHERE datname='${esc_db}';" | tr -d '[:space:]')"

  if [[ "$db_exists" == "1" ]]; then
    log "Database '${DB_NAME}' already exists. Checking privileges."

    has_connect="$(admin_psql "SELECT has_database_privilege('"$(sql_escape "$APP_DB_USER")"', '"$(sql_escape "$DB_NAME")"', 'CONNECT');" | tr -d '[:space:]')"
    has_create="$(admin_psql "SELECT has_database_privilege('"$(sql_escape "$APP_DB_USER")"', '"$(sql_escape "$DB_NAME")"', 'CREATE');" | tr -d '[:space:]')"

    if [[ "$has_connect" != "t" || "$has_create" != "t" ]]; then
      warn "User '${APP_DB_USER}' does not have sufficient privileges on '${DB_NAME}'."
      warn 'Required privileges: CONNECT, CREATE'
      exit 1
    fi
  else
    log "Creating database '${DB_NAME}'."
    admin_psql "CREATE DATABASE \"$DB_NAME\" OWNER \"$APP_DB_USER\";" >/dev/null
    admin_psql "GRANT ALL PRIVILEGES ON DATABASE \"$DB_NAME\" TO \"$APP_DB_USER\";" >/dev/null
  fi
}

app_psql() {
  local sql="$1"
  PGPASSWORD="$APP_DB_PASS" psql -h "$ADMIN_DB_HOST" -p "$ADMIN_DB_PORT" -U "$APP_DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -c "$sql"
}

create_user_data_table() {
  log "Creating user_data table in database '${DB_NAME}'."
  app_psql 'CREATE TABLE IF NOT EXISTS user_data (id TEXT PRIMARY KEY, jsonvalue JSONB NOT NULL);' >/dev/null
}

upsert_env_key() {
  local env_file="$1"
  local key="$2"
  local value="$3"
  local escaped

  escaped="$(printf "%s" "$value" | sed -e 's/[\/&]/\\&/g')"
  if [[ -f "$env_file" ]] && grep -q "^${key}=" "$env_file"; then
    sed -i "s/^${key}=.*/${key}=${escaped}/" "$env_file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$env_file"
  fi
}

assign_to_env() {
  local env_file
  env_file="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.env"

  if [[ ! -f "$env_file" ]]; then
    touch "$env_file"
  fi

  # Intentionally avoid overwriting DB_* used by index.js.
  upsert_env_key "$env_file" "DB_USER" "$APP_DB_USER"
  upsert_env_key "$env_file" "DB_PASSWORD" "$APP_DB_PASS"
  upsert_env_key "$env_file" "DB_NAME" "$DB_NAME"
  log "Saved DB_USER / DB_PASSWORD / DB_NAME to .env"
}

main() {
  prompt_os
  maybe_install_postgres
  ensure_service_running_linux
  configure_admin_access
  ensure_role_exists
  prompt_database_name
  ensure_database_and_privileges
  create_user_data_table
  assign_to_env
  log 'Done.'
}

main
