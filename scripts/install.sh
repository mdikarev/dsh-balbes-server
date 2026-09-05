#!/usr/bin/env bash
#
# One-command installer for the dsh "balbes" profile (Stage 1).
#
# Entry point pinned by docs/runbooks/stage1-vps.md:
#
#   curl -fsSL https://raw.githubusercontent.com/mdikarev/dsh-balbes-server/main/scripts/install.sh | bash
#
# Provisions the environment (Node >= 22 via NodeSource, pnpm, git), installs
# the global @deepseek-ai/dsh CLI (never patched or edited — dsh is a
# dependency, not a fork), syncs profiles/balbes from the repository into
# $DSH_HOME/profiles, stores the DeepSeek API key in
# $DSH_HOME/.credentials.yaml, verifies the profile composes with
# `dsh --profile balbes --dump-config`, and prints the manual smoke command.
# Safe to re-run: every step is an idempotent update.
#
# Honored environment:
#   DEEPSEEK_API_KEY     key; when unset the script prompts on /dev/tty
#   DSH_HOME             dsh data dir (default: $HOME/.dsh)
#   DSH_BALBES_REPO_DIR  repo checkout dir (default: $HOME/dsh-balbes-server)
#
# Target: Ubuntu with a sudo-capable user (see runbook "Требования"). Base
# bundles are never pnpm-installed here — the npm registry serves stale broken
# @deepseek-ai/dsh-* versions; bundles resolve from the dsh install mirror at
# profile load time.

set -euo pipefail

# --- configuration ------------------------------------------------------------

REPO_URL="https://github.com/mdikarev/dsh-balbes-server"
REPO_DIR="${DSH_BALBES_REPO_DIR:-$HOME/dsh-balbes-server}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
CREDENTIALS_FILE="$DSH_HOME/.credentials.yaml"
PROFILE_NAME="balbes"
NODE_MAJOR_MIN=22
NODESOURCE_SETUP_URL="https://deb.nodesource.com/setup_${NODE_MAJOR_MIN}.x"

# --- small helpers ------------------------------------------------------------

info() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

# run_priv ARG... — run ARG with root privileges: sudo when non-root, plain
# when already root. The documented path is a non-root sudo user; running as
# root also works (npm -g then installs into the root prefix directly).
run_priv() {
    if [[ "$(id -u)" -eq 0 ]]; then
        "$@"
    elif command -v sudo >/dev/null 2>&1; then
        sudo "$@"
    else
        die "sudo is required for privileged steps (running as $(id -un))"
    fi
}

# run_pipe ARG... — run stdin through ARG with root privileges, keeping the
# environment under sudo: `curl -fsSL URL | run_pipe bash -` behaves as the
# runbook's `curl ... | sudo -E bash -` (plain `bash -` when already root).
run_pipe() {
    if [[ "$(id -u)" -eq 0 ]]; then
        "$@"
    elif command -v sudo >/dev/null 2>&1; then
        sudo -E "$@"
    else
        die "sudo is required for privileged steps (running as $(id -un))"
    fi
}

APT_UPDATED=0
# apt_install PKG — install one apt package when its binary is missing.
apt_install() {
    local pkg="$1"
    if command -v "$pkg" >/dev/null 2>&1; then
        return 0
    fi
    if [[ "$APT_UPDATED" -eq 0 ]]; then
        info "Running apt-get update (first missing apt package)..."
        run_priv apt-get update
        APT_UPDATED=1
    fi
    run_priv apt-get install -y "$pkg"
    hash -r
}

# yaml_quote VALUE — render VALUE as a double-quoted YAML scalar (escapes
# backslashes and double quotes), safe for arbitrary printable key material.
yaml_quote() {
    local s="${1:-}"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    printf '"%s"' "$s"
}

# --- credentials file ($DSH_HOME/.credentials.yaml) ---------------------------
#
# Layout verified against @deepseek-ai/dsh-credentials-local: a version-1 YAML
# document whose only top-level keys are version/refs/records; refs maps env
# names to non-empty string values; the file must be readable only by its
# owner (dsh refuses to read it with group/other bits set) and duplicate keys
# are a parse error — so an existing DEEPSEEK_API_KEY entry is never repeated.

# write_credentials_file KEY — store refs.DEEPSEEK_API_KEY.
# Absent file: written whole (version: 1 + refs + empty records), mode 600.
# Existing file: other content is never destroyed; a clean top-level `refs:`
# line gets the key appended under it (one line), otherwise the file is left
# untouched and manual instructions are printed.
write_credentials_file() {
    local key="${1:-}"
    local file="${CREDENTIALS_FILE:-${DSH_HOME:-$HOME/.dsh}/.credentials.yaml}"
    if [[ -z "$key" ]]; then
        warn "empty API key — nothing stored"
        return 0
    fi
    if [[ "$key" == *$'\n'* || "$key" == *$'\r'* ]]; then
        die "API key contains a line break — refusing to write it"
    fi
    if [[ -e "$file" ]]; then
        append_key_to_credentials "$file" "$key"
    else
        create_credentials_file "$file" "$key"
    fi
}

# create_credentials_file FILE KEY — write a fresh version-1 document, 0600.
create_credentials_file() {
    local file="$1" key="$2"
    local dir quoted tmp
    dir="$(dirname "$file")"
    mkdir -p "$dir"
    quoted="$(yaml_quote "$key")"
    tmp="$dir/.credentials.yaml.tmp.$$"
    (
        umask 077
        {
            printf 'version: 1\n'
            printf 'refs:\n'
            printf '  DEEPSEEK_API_KEY: %s\n' "$quoted"
            printf 'records: {}\n'
        } >"$tmp"
    )
    chmod 600 "$tmp"
    mv -f "$tmp" "$file"
    info "Wrote $file with refs.DEEPSEEK_API_KEY (mode 600)."
}

# append_key_to_credentials FILE KEY — append the key under an existing clean
# top-level `refs:` section, matching the indentation of entries already
# there. Refuses (leaves the file untouched + prints manual instructions)
# when the key already exists or no clean `refs:` line is present.
append_key_to_credentials() {
    local file="$1" key="$2"
    if grep -Eq '^[[:space:]]*DEEPSEEK_API_KEY:' "$file"; then
        info "note: $file already holds a DEEPSEEK_API_KEY entry — left unchanged."
        info "      To change the key, edit refs.DEEPSEEK_API_KEY in $file manually."
        return 0
    fi
    # Only `refs:` with nothing after the colon (no inline map, no comment)
    # is a shape this text-level append can keep valid.
    local refs_hit
    refs_hit="$(grep -nE '^refs:[[:space:]]*$' "$file" | head -n 1 || true)"
    if [[ -z "$refs_hit" ]]; then
        warn "$file exists without a clean top-level refs: line — not rewriting it."
        manual_credentials_hint "$file"
        return 0
    fi
    local line_no indent quoted tmp
    line_no="${refs_hit%%:*}"
    # Match the indentation of refs entries already in the file (default: 2).
    indent="$(awk -v n="$line_no" '
        NR <= n { next }
        /^[[:space:]]*$/ || /^[[:space:]]*#/ { next }
        /^[[:space:]]+/ { match($0, /^[[:space:]]+/); print substr($0, 1, RLENGTH); exit }
        { exit }
    ' "$file")"
    indent="${indent:-  }"
    quoted="$(yaml_quote "$key")"
    tmp="${file}.tmp.$$"
    (
        umask 077
        # The key line travels via the environment, NOT through awk -v: awk
        # applies C-escape processing to -v values (\\ -> \, \" -> "), which
        # would corrupt the already-YAML-escaped key the moment it contains a
        # literal backslash or quote. ENVIRON carries the bytes verbatim.
        LINE="${indent}DEEPSEEK_API_KEY: ${quoted}" awk -v n="$line_no" \
            'NR == n { print; print ENVIRON["LINE"]; next } { print }' "$file" >"$tmp"
    )
    chmod 600 "$tmp"
    mv -f "$tmp" "$file"
    info "Appended refs.DEEPSEEK_API_KEY to $file (mode 600)."
}

# manual_credentials_hint FILE — exact format for a hand edit (stderr).
manual_credentials_hint() {
    local file="$1"
    cat >&2 <<EOF
Add the key manually to the refs section of $file
(leave every other section intact):

  version: 1
  refs:
    DEEPSEEK_API_KEY: <your-key>

Then make the file readable only by you:

  chmod 600 $file
EOF
}

# prompt_api_key — read the key silently from the controlling terminal, so the
# prompt works inside `curl ... | bash` (the script's stdin is the consumed
# pipe, not the terminal). Prints the key on stdout; empty when skipped.
prompt_api_key() {
    local key=""
    # /dev/tty usually exists as a device node but cannot be opened without a
    # controlling terminal (cron, CI, ssh without -t); a failed open must not
    # abort the install — probe it first, silently.
    if ! ( : < /dev/tty ) 2>/dev/null; then
        warn "no usable controlling terminal (/dev/tty) — skipping API key prompt"
        return 0
    fi
    printf 'DeepSeek API key (leave empty to skip): ' >&2
    if ! read -rs key </dev/tty; then
        printf '\n' >&2
        warn "could not read /dev/tty — skipping API key prompt"
        return 0
    fi
    printf '\n' >&2
    printf '%s' "$key"
}

# --- environment steps (idempotent) ------------------------------------------

# node_ready — node >= 22 AND npm present. npm ships with the NodeSource
# install, while a bare apt nodejs often lacks it — and npm is what installs
# dsh and pnpm here. dsh itself needs node >= 22 (node:sqlite).
node_ready() {
    command -v node >/dev/null 2>&1 || return 1
    command -v npm >/dev/null 2>&1 || return 1
    local v major
    v="$(node --version 2>/dev/null || true)"
    major="${v#v}"
    major="${major%%.*}"
    [[ "$major" =~ ^[0-9]+$ ]] || return 1
    (( major >= NODE_MAJOR_MIN ))
}

install_node_22() {
    info "Installing Node.js ${NODE_MAJOR_MIN} LTS via NodeSource (node >= ${NODE_MAJOR_MIN} required by dsh)..."
    if ! command -v curl >/dev/null 2>&1; then
        apt_install curl
    fi
    curl -fsSL "$NODESOURCE_SETUP_URL" | run_pipe bash -
    run_priv apt-get install -y nodejs
    hash -r
    node_ready || die "node >= ${NODE_MAJOR_MIN} still unavailable after the NodeSource install"
    info "node $(node --version) ready"
}

ensure_tooling() {
    if node_ready; then
        info "node $(node --version) ready"
    else
        install_node_22
    fi
    if command -v pnpm >/dev/null 2>&1; then
        info "pnpm $(pnpm --version 2>/dev/null || true) ready"
    else
        info "Installing pnpm globally (npm i -g pnpm)..."
        run_priv npm install -g pnpm
        hash -r
        command -v pnpm >/dev/null 2>&1 || die "pnpm not found after the global install"
        info "pnpm installed"
    fi
    if command -v git >/dev/null 2>&1; then
        info "git $(git --version 2>/dev/null || true) ready"
    else
        info "Installing git via apt..."
        apt_install git
    fi
}

ensure_dsh() {
    if command -v dsh >/dev/null 2>&1; then
        info "dsh already installed"
        return 0
    fi
    info "Installing @deepseek-ai/dsh globally (npm i -g @deepseek-ai/dsh)..."
    run_priv npm install -g @deepseek-ai/dsh
    hash -r
    # npm's global bin dir may not be on this shell's PATH; locate dsh there.
    if ! command -v dsh >/dev/null 2>&1; then
        local npm_bin
        npm_bin="$(npm prefix -g 2>/dev/null || true)/bin"
        if [[ -n "$npm_bin" && -x "$npm_bin/dsh" ]]; then
            PATH="$npm_bin:$PATH"
            export PATH
        fi
    fi
    command -v dsh >/dev/null 2>&1 || die "dsh not found after the global install (check PATH)"
    info "dsh installed ($(command -v dsh))"
}

ensure_repo() {
    if [[ -d "$REPO_DIR/.git" || -f "$REPO_DIR/.git" ]]; then
        info "Updating repo at $REPO_DIR (git pull --ff-only)..."
        git -C "$REPO_DIR" pull --ff-only
    elif [[ -e "$REPO_DIR" ]]; then
        die "$REPO_DIR exists but is not a git checkout — move it away or set DSH_BALBES_REPO_DIR"
    else
        info "Cloning $REPO_URL into $REPO_DIR..."
        git clone "$REPO_URL" "$REPO_DIR"
    fi
}

# sync_profile — repository profile is the source of truth: the installed copy
# is replaced wholesale (rm + cp) so a stale local copy cannot survive.
sync_profile() {
    local src="$REPO_DIR/profiles/$PROFILE_NAME"
    local profiles_dir dst
    if [[ ! -f "$src/package.json" ]]; then
        die "profile '$PROFILE_NAME' not found at $src (is the repo up to date?)"
    fi
    mkdir -p "$DSH_HOME/profiles"
    profiles_dir="$(cd "$DSH_HOME/profiles" && pwd -P)"
    if [[ "$profiles_dir" == "/" ]]; then
        die "refusing to operate on '$profiles_dir' (DSH_HOME resolves to filesystem root)"
    fi
    dst="$profiles_dir/$PROFILE_NAME"
    info "Syncing profile $src -> $dst ..."
    rm -rf "$dst"
    cp -R "$src" "$dst"
    info "Profile synced."
}

# --- key ----------------------------------------------------------------------

configure_api_key() {
    local key="${DEEPSEEK_API_KEY:-}"
    if [[ -z "$key" ]]; then
        key="$(prompt_api_key || true)"
    fi
    if [[ -z "$key" ]]; then
        info "No API key provided — skipped. Add one later per the runbook."
        return 0
    fi
    write_credentials_file "$key"
}

# --- verification + finish ----------------------------------------------------

verify_composition() {
    info "Verifying profile composition: dsh --profile $PROFILE_NAME --dump-config"
    if ! DSH_HOME="$DSH_HOME" dsh --profile "$PROFILE_NAME" --dump-config >/dev/null; then
        die "profile composition check failed — see runbook 'Устранение неполадок'"
    fi
    info "Profile '$PROFILE_NAME' composes OK."
}

print_smoke_instruction() {
    cat <<'EOF'

=====================================================================
Installation complete. Run the smoke check:

  dsh --profile balbes "Напиши 'ok' и больше ничего"
=====================================================================
EOF
}

main() {
    info "== dsh '$PROFILE_NAME' profile installer (Stage 1) =="
    info "repo: $REPO_URL -> $REPO_DIR"
    info "dsh home: $DSH_HOME"
    if [[ "$(id -u)" -eq 0 ]]; then
        warn "running as root: privileged steps skip sudo; npm -g installs go to the root prefix"
    fi
    ensure_tooling
    ensure_dsh
    ensure_repo
    sync_profile
    configure_api_key
    verify_composition
    print_smoke_instruction
}

# Run main when executed directly — as a file (`bash install.sh`) or via
# stdin (`curl ... | bash`, where BASH_SOURCE[0] is unset) — but not when
# sourced (tests load functions with `source install.sh`).
if [[ "${BASH_SOURCE[0]:-}" == "$0" || -z "${BASH_SOURCE[0]:-}" ]]; then
    main "$@"
fi
