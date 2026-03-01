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
  read -r -p '운영체제를 선택하세요 (1/2): ' choice

  case "$choice" in
    1) OS_CHOICE="windows" ;;
    2) OS_CHOICE="linux" ;;
    *)
      err '잘못된 선택입니다. 1 또는 2를 입력하세요.'
      exit 1
      ;;
  esac
}

prompt_app_credentials() {
  read -r -p 'PostgreSQL 사용자 이름을 입력하세요: ' APP_DB_USER
  if [[ -z "$APP_DB_USER" ]]; then
    err '사용자 이름은 비워둘 수 없습니다.'
    exit 1
  fi

  read -r -s -p 'PostgreSQL 비밀번호를 입력하세요: ' APP_DB_PASS
  printf '\n'
  if [[ -z "$APP_DB_PASS" ]]; then
    err '비밀번호는 비워둘 수 없습니다.'
    exit 1
  fi
}

is_postgres_installed() {
  command -v psql >/dev/null 2>&1
}

install_postgres_windows() {
  if command -v winget >/dev/null 2>&1; then
    log 'winget으로 PostgreSQL을 설치합니다.'
    winget install --id PostgreSQL.PostgreSQL --accept-source-agreements --accept-package-agreements
    return
  fi

  if command -v choco >/dev/null 2>&1; then
    log 'choco로 PostgreSQL을 설치합니다.'
    choco install postgresql -y
    return
  fi

  if command -v scoop >/dev/null 2>&1; then
    log 'scoop으로 PostgreSQL을 설치합니다.'
    scoop install postgresql
    return
  fi

  err 'Windows 패키지 매니저(winget/choco/scoop)를 찾지 못했습니다.'
  err 'PostgreSQL을 수동 설치 후 스크립트를 다시 실행하세요.'
  exit 1
}

install_postgres_linux() {
  if command -v apt-get >/dev/null 2>&1; then
    log 'apt-get으로 PostgreSQL을 설치합니다.'
    sudo apt-get update
    sudo apt-get install -y postgresql postgresql-contrib
    return
  fi

  if command -v dnf >/dev/null 2>&1; then
    log 'dnf로 PostgreSQL을 설치합니다.'
    sudo dnf install -y postgresql-server postgresql-contrib
    return
  fi

  if command -v yum >/dev/null 2>&1; then
    log 'yum으로 PostgreSQL을 설치합니다.'
    sudo yum install -y postgresql-server postgresql-contrib
    return
  fi

  if command -v pacman >/dev/null 2>&1; then
    log 'pacman으로 PostgreSQL을 설치합니다.'
    sudo pacman -Sy --noconfirm postgresql
    return
  fi

  if command -v zypper >/dev/null 2>&1; then
    log 'zypper로 PostgreSQL을 설치합니다.'
    sudo zypper --non-interactive install postgresql-server postgresql-contrib
    return
  fi

  err '지원되는 Linux 패키지 매니저를 찾지 못했습니다.'
  err 'PostgreSQL을 수동 설치 후 스크립트를 다시 실행하세요.'
  exit 1
}

maybe_install_postgres() {
  if is_postgres_installed; then
    log 'PostgreSQL이 이미 설치되어 있습니다.'
    prompt_app_credentials
    return
  fi

  warn 'PostgreSQL이 설치되어 있지 않습니다.'
  read -r -p '설치하시겠습니까? (y/n): ' install_answer

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
      err 'PostgreSQL 설치가 필요합니다. 스크립트를 종료합니다.'
      exit 1
      ;;
    *)
      err 'y 또는 n으로 입력하세요.'
      exit 1
      ;;
  esac

  if ! is_postgres_installed; then
    err '설치 이후에도 psql 명령을 찾을 수 없습니다. PATH를 확인하세요.'
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

  if [[ "$ADMIN_MODE" == "sudo" ]]; then
    sudo -u postgres psql -d postgres -tAc "$sql"
    return
  fi

  PGPASSWORD="$ADMIN_DB_PASS" psql -h "$ADMIN_DB_HOST" -p "$ADMIN_DB_PORT" -U "$ADMIN_DB_USER" -d postgres -tAc "$sql"
}

configure_admin_access() {
  read -r -p '관리자(PostgreSQL superuser) 계정명 [postgres]: ' in_admin_user
  if [[ -n "$in_admin_user" ]]; then
    ADMIN_DB_USER="$in_admin_user"
  fi

  read -r -s -p '관리자 비밀번호(없으면 엔터): ' ADMIN_DB_PASS
  printf '\n'

  if admin_psql 'SELECT 1;' >/dev/null 2>&1; then
    return
  fi

  if [[ "$OS_CHOICE" == "linux" ]] && command -v sudo >/dev/null 2>&1; then
    ADMIN_MODE="sudo"
    if admin_psql 'SELECT 1;' >/dev/null 2>&1; then
      log 'sudo -u postgres 방식으로 관리자 접속을 사용합니다.'
      return
    fi
  fi

  err '관리자 계정으로 PostgreSQL 접속에 실패했습니다.'
  err '관리자 계정/비밀번호 또는 pg_hba.conf 설정을 확인하세요.'
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
    log "사용자 '${APP_DB_USER}'가 이미 존재하여 비밀번호를 갱신합니다."
    admin_psql "ALTER ROLE \"$APP_DB_USER\" WITH LOGIN PASSWORD '${esc_pass}';" >/dev/null
  else
    log "사용자 '${APP_DB_USER}'를 생성합니다."
    admin_psql "CREATE ROLE \"$APP_DB_USER\" WITH LOGIN PASSWORD '${esc_pass}';" >/dev/null
  fi
}

prompt_database_name() {
  read -r -p '사용할 데이터베이스 이름을 입력하세요: ' DB_NAME
  if [[ -z "$DB_NAME" ]]; then
    err '데이터베이스 이름은 비워둘 수 없습니다.'
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
    log "데이터베이스 '${DB_NAME}'가 이미 존재합니다. 권한을 확인합니다."

    has_connect="$(admin_psql "SELECT has_database_privilege('"$(sql_escape "$APP_DB_USER")"', '"$(sql_escape "$DB_NAME")"', 'CONNECT');" | tr -d '[:space:]')"
    has_create="$(admin_psql "SELECT has_database_privilege('"$(sql_escape "$APP_DB_USER")"', '"$(sql_escape "$DB_NAME")"', 'CREATE');" | tr -d '[:space:]')"

    if [[ "$has_connect" != "t" || "$has_create" != "t" ]]; then
      warn "사용자 '${APP_DB_USER}'에게 데이터베이스 '${DB_NAME}' 권한이 충분하지 않습니다."
      warn "필요 권한: CONNECT, CREATE"
      exit 1
    fi
  else
    log "데이터베이스 '${DB_NAME}'를 생성합니다."
    admin_psql "CREATE DATABASE \"$DB_NAME\" OWNER \"$APP_DB_USER\";" >/dev/null
    admin_psql "GRANT ALL PRIVILEGES ON DATABASE \"$DB_NAME\" TO \"$APP_DB_USER\";" >/dev/null
  fi
}

app_psql() {
  local sql="$1"
  PGPASSWORD="$APP_DB_PASS" psql -h "$ADMIN_DB_HOST" -p "$ADMIN_DB_PORT" -U "$APP_DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -c "$sql"
}

create_user_data_table() {
  log "데이터베이스 '${DB_NAME}'를 사용하여 user_data 테이블을 생성합니다."
  app_psql 'CREATE TABLE IF NOT EXISTS user_data (id TEXT PRIMARY KEY, jsonvalue JSONB NOT NULL);' >/dev/null
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
  log '완료'
}

main
