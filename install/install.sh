#!/usr/bin/env bash
# Install Dukebox on a Debian or Ubuntu machine.
#
#   curl -fsSL https://raw.githubusercontent.com/diegodev18/dukebox/main/install/install.sh | bash
#
# Idempotent: running it again updates the installation without touching
# generated secrets or existing data. Two steps cannot be automated —
# `tailscale up` and `gh auth login` are interactive and cannot run inside a
# pipe — so the script detects them and prints what to run instead of hanging
# on a prompt nobody can see.
set -euo pipefail

REPO_URL="${DUKEBOX_REPO_URL:-https://github.com/diegodev18/dukebox.git}"
REPO_REF="${DUKEBOX_REPO_REF:-main}"
INSTALL_DIR="${DUKEBOX_INSTALL_DIR:-/opt/dukebox}"
CONFIG_DIR="${DUKEBOX_CONFIG_DIR:-/etc/dukebox}"
SERVICE_USER="${DUKEBOX_USER:-dukebox}"
SERVER_PORT="${DUKEBOX_SERVER_PORT:-7777}"
NODE_MAJOR=22

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m  %s\n' "$*" >&2; }
die()  { printf '\033[1;31mx\033[0m  %s\n' "$*" >&2; exit 1; }

# Run a command as the service user. Anything touching the checkout or the
# service's own credentials has to, or it leaves files root cannot hand back.
as_service_user() {
  su -s /bin/sh "$SERVICE_USER" -c "$1"
}

# Every apt call in one place, so the package list is refreshed at most once.
apt_updated=false
apt_install() {
  if [ "$apt_updated" = false ]; then
    apt-get update -qq
    apt_updated=true
  fi
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "$@"
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

require_root() {
  [ "$(id -u)" -eq 0 ] || die "run this as root: curl -fsSL … | sudo bash"
}

require_supported_os() {
  [ -r /etc/os-release ] || die "cannot identify this system: /etc/os-release is missing"

  # shellcheck disable=SC1091
  . /etc/os-release

  case "${ID:-}${ID_LIKE:-}" in
    *debian*|*ubuntu*) ;;
    *) die "Dukebox installs on Debian and Ubuntu; this is ${PRETTY_NAME:-unknown}" ;;
  esac

  case "$(dpkg --print-architecture)" in
    amd64|arm64) ;;
    *) die "unsupported architecture: $(dpkg --print-architecture)" ;;
  esac
}

# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------

install_base_packages() {
  local missing=()

  # Checked with dpkg rather than `command -v`: ca-certificates and gnupg
  # install no binary of their own name, so a command check reinstalls them on
  # every run.
  for package in curl git ca-certificates gnupg openssl; do
    dpkg-query --show --showformat='${Status}' "$package" 2>/dev/null \
      | grep -q '^install ok installed$' || missing+=("$package")
  done

  if [ ${#missing[@]} -gt 0 ]; then
    log "Installing ${missing[*]}"
    apt_install "${missing[@]}"
  fi
}

install_docker() {
  if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
    return
  fi

  log "Installing Docker"
  # Docker's own convenience script, which handles the apt repository, key, and
  # the compose plugin across both distributions.
  curl -fsSL https://get.docker.com | sh
}

install_node() {
  # Node runs the control plane on the host. The version is pinned to a major
  # so a distribution's older packaged Node cannot be picked up instead.
  if command -v node >/dev/null; then
    local current
    current="$(node --version | sed 's/^v\([0-9]*\).*/\1/')"
    [ "$current" -ge "$NODE_MAJOR" ] && return
    warn "Node $(node --version) is older than v${NODE_MAJOR}; installing a newer one"
  fi

  log "Installing Node ${NODE_MAJOR}"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt_updated=false
  apt_install nodejs
}

install_gh() {
  command -v gh >/dev/null && return

  log "Installing the GitHub CLI"
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
  chmod 0644 /etc/apt/keyrings/githubcli-archive-keyring.gpg

  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list

  apt_updated=false
  apt_install gh
}

install_tailscale() {
  command -v tailscale >/dev/null && return

  log "Installing Tailscale"
  curl -fsSL https://tailscale.com/install.sh | sh
}

install_pnpm() {
  command -v pnpm >/dev/null && return

  log "Installing pnpm"
  corepack enable
  corepack prepare pnpm@10.24.0 --activate
}

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

create_service_user() {
  id "$SERVICE_USER" >/dev/null 2>&1 && return

  log "Creating the ${SERVICE_USER} user"
  useradd --system --create-home --home-dir "/var/lib/${SERVICE_USER}" \
    --shell /usr/sbin/nologin "$SERVICE_USER"

  # Managing session containers means talking to the Docker socket.
  usermod -aG docker "$SERVICE_USER"
}

generate_config() {
  install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$CONFIG_DIR"

  # Secrets are generated once. Regenerating them on a re-run would orphan
  # every encrypted secret in the database and invalidate every paired device.
  if [ ! -f "${CONFIG_DIR}/master.key" ]; then
    log "Generating the master encryption key"
    openssl rand -base64 32 > "${CONFIG_DIR}/master.key"
    chmod 0600 "${CONFIG_DIR}/master.key"
    chown "$SERVICE_USER:$SERVICE_USER" "${CONFIG_DIR}/master.key"
  fi

  if [ ! -f "${CONFIG_DIR}/env" ]; then
    log "Generating database credentials"
    {
      echo "DUKEBOX_POSTGRES_PASSWORD=$(openssl rand -hex 24)"
    } > "${CONFIG_DIR}/env"
    chmod 0600 "${CONFIG_DIR}/env"
    chown "$SERVICE_USER:$SERVICE_USER" "${CONFIG_DIR}/env"
  fi

  # shellcheck disable=SC1091
  . "${CONFIG_DIR}/env"

  if [ ! -f "${CONFIG_DIR}/config.toml" ]; then
    log "Writing ${CONFIG_DIR}/config.toml"
    cat > "${CONFIG_DIR}/config.toml" <<EOF
# Written by install.sh. Safe to edit; restart with:
#   systemctl restart dukebox

[server]
transport = "tailscale"
port = ${SERVER_PORT}

[database]
url = "postgres://dukebox:${DUKEBOX_POSTGRES_PASSWORD}@127.0.0.1:5432/dukebox"

[redis]
url = "redis://127.0.0.1:6379"

[security]
master_key_file = "${CONFIG_DIR}/master.key"

[sandbox]
default_image = "dukebox/base-node:latest"
cpu_limit = "2"
memory_limit = "4g"
EOF
    chmod 0640 "${CONFIG_DIR}/config.toml"
    chown "$SERVICE_USER:$SERVICE_USER" "${CONFIG_DIR}/config.toml"
  fi
}

# ---------------------------------------------------------------------------
# Application
# ---------------------------------------------------------------------------

fetch_source() {
  if [ -d "${INSTALL_DIR}/.git" ]; then
    log "Updating Dukebox"
    # Run as the owner. The checkout belongs to the service user, and git
    # refuses to operate on a repository owned by someone else — which only
    # shows up on the second run, when the directory already exists.
    as_service_user "git -C '$INSTALL_DIR' fetch --quiet origin '$REPO_REF'"
    as_service_user "git -C '$INSTALL_DIR' reset --quiet --hard 'origin/${REPO_REF}'"
  else
    log "Fetching Dukebox"
    git clone --quiet --branch "$REPO_REF" "$REPO_URL" "$INSTALL_DIR"
    chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
  fi
}

build_application() {
  log "Building"
  # Only the control plane and what it depends on. The desktop app is a native
  # binary for the user's own machine — building it here would pull in Vite and
  # a Rust toolchain to produce something this server never runs. The trailing
  # "..." includes the workspace packages the server imports.
  #
  # As the service user, so the build output is owned by whoever runs it.
  as_service_user "cd '$INSTALL_DIR' && pnpm install --frozen-lockfile --filter '@dukebox/server...' && pnpm --filter '@dukebox/server...' build"
}

# Steps that can fail for reasons specific to a machine. Reported rather than
# fatal: an operator who reaches the end with a clear list of what is left can
# fix it, whereas an abort here leaves them with no instructions at all.
image_ok=true
dependencies_ok=true

build_agent_image() {
  log "Building the agent image"

  if ! docker build --quiet -t dukebox/base-node:latest \
      "${INSTALL_DIR}/images/base-node" >/dev/null 2>&1; then
    warn "could not build the agent image"
    image_ok=false
  fi
}

start_dependencies() {
  log "Starting Postgres and Redis"

  if ! docker compose \
      --project-directory "${INSTALL_DIR}/install" \
      --env-file "${CONFIG_DIR}/env" \
      up -d --wait 2>&1; then
    warn "could not start Postgres and Redis"
    dependencies_ok=false
  fi
}

install_service() {
  log "Installing the systemd service"
  install -m 0644 "${INSTALL_DIR}/install/dukebox.service" /etc/systemd/system/dukebox.service

  systemctl daemon-reload
  systemctl enable --quiet dukebox
}

# ---------------------------------------------------------------------------
# Interactive steps
#
# Neither can run here: both need a terminal, and this script is usually read
# from a pipe. Detected and reported so the operator knows exactly what is
# left, rather than watching an invisible prompt time out.
# ---------------------------------------------------------------------------

check_tailscale() {
  local state
  state="$(tailscale status --json 2>/dev/null | grep -o '"BackendState"[^,]*' | cut -d'"' -f4 || true)"

  [ "$state" = "Running" ] && return 0

  warn "Tailscale is not connected (state: ${state:-unknown})"
  return 1
}

check_github() {
  # As the service user: its credentials are the ones the control plane uses.
  as_service_user "gh auth status" >/dev/null 2>&1 && return 0

  warn "the GitHub CLI is not authenticated as ${SERVICE_USER}"
  return 1
}

# Dukebox authenticates git over HTTPS through a credential proxy that keeps the
# token out of agent containers. With gh configured for SSH, clones would look
# for a key the container does not have and fail with an error that says nothing
# about the real cause.
check_git_protocol() {
  local protocol
  protocol="$(as_service_user "gh config get git_protocol" 2>/dev/null || true)"

  [ "$protocol" != "ssh" ] && return 0

  warn "gh is set to use SSH for git; Dukebox needs HTTPS"
  echo "     Fix it with:" >&2
  echo "       sudo -u ${SERVICE_USER} gh config set git_protocol https" >&2
  return 1
}

print_next_steps() {
  local tailscale_ok="$1" github_ok="$2"
  local step=1

  echo
  echo "  Dukebox is installed. These steps are left:"
  echo

  if [ "$tailscale_ok" != "true" ]; then
    echo "    ${step}. Join your tailnet:"
    echo "         sudo tailscale up"
    echo
    step=$((step + 1))
  fi

  if [ "$github_ok" != "true" ]; then
    if as_service_user "gh auth status" >/dev/null 2>&1; then
      # Signed in already; only the protocol is wrong.
      echo "    ${step}. Switch gh to HTTPS:"
      echo "         sudo -u ${SERVICE_USER} gh config set git_protocol https"
    else
      echo "    ${step}. Sign in to GitHub as the service user:"
      echo "         sudo -u ${SERVICE_USER} gh auth login"
      echo
      echo "       Two of its questions matter:"
      echo "         ? Preferred protocol for Git operations ......... HTTPS"
      echo "         ? Authenticate Git with your GitHub credentials .. Y"
    fi

    echo
    echo "       Dukebox authenticates git over HTTPS through a proxy that keeps"
    echo "       your token out of agent containers. Over SSH that proxy is"
    echo "       bypassed, and clones fail looking for a key the container"
    echo "       does not have."
    echo
    step=$((step + 1))
  fi

  if [ "$image_ok" != "true" ]; then
    echo "    ${step}. Build the agent image:"
    echo "         sudo docker build -t dukebox/base-node:latest ${INSTALL_DIR}/images/base-node"
    echo
    step=$((step + 1))
  fi

  if [ "$dependencies_ok" != "true" ]; then
    echo "    ${step}. Start Postgres and Redis:"
    echo "         sudo docker compose --project-directory ${INSTALL_DIR}/install \\"
    echo "           --env-file ${CONFIG_DIR}/env up -d"
    echo
    step=$((step + 1))
  fi

  echo "    ${step}. Start Dukebox and get a pairing link:"
  echo "         sudo systemctl start dukebox"
  echo "         sudo -u ${SERVICE_USER} DUKEBOX_CONFIG=${CONFIG_DIR}/config.toml \\"
  echo "           node ${INSTALL_DIR}/apps/server/dist/cli.js pair new"
  echo
}

print_pairing_link() {
  log "Starting Dukebox"
  systemctl restart dukebox

  # A moment for the service to bind before asking it for anything.
  sleep 3

  if ! systemctl is-active --quiet dukebox; then
    warn "Dukebox failed to start. See: journalctl -u dukebox -n 50"
    return 1
  fi

  echo
  su -s /bin/sh "$SERVICE_USER" -c \
    "cd '$INSTALL_DIR' && DUKEBOX_CONFIG='${CONFIG_DIR}/config.toml' node apps/server/dist/cli.js pair new"
}

# ---------------------------------------------------------------------------

main() {
  require_root
  require_supported_os

  install_base_packages
  install_docker
  install_node
  install_pnpm
  install_gh
  install_tailscale

  create_service_user
  generate_config

  fetch_source
  build_application

  # Installed before the steps that can fail on a particular machine, so a
  # failure there leaves a system an operator can fix and start by hand rather
  # than one with no service definition at all.
  install_service

  build_agent_image
  start_dependencies

  local tailscale_ok=false github_ok=false
  check_tailscale && tailscale_ok=true

  # Both must hold: gh signed in, and set to HTTPS. Signed in over SSH looks
  # authenticated but every clone would still fail.
  if check_github && check_git_protocol; then
    github_ok=true
  fi

  if [ "$tailscale_ok" = true ] && [ "$github_ok" = true ] &&
     [ "$image_ok" = true ] && [ "$dependencies_ok" = true ]; then
    print_pairing_link
  else
    print_next_steps "$tailscale_ok" "$github_ok"
  fi
}

main "$@"
