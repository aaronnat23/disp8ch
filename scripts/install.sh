#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${DISP8CH_APP_DIR:-$HOME/.local/share/disp8ch/app}"
BRANCH="${DISP8CH_BRANCH:-main}"
NO_START=0
SKIP_BROWSER_OPEN=0
REPO_URL="${DISP8CH_REPO_URL:-}"
SOURCE_ZIP_URL="${DISP8CH_SOURCE_ZIP_URL:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) APP_DIR="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --repo) REPO_URL="$2"; shift 2 ;;
    --source-zip) SOURCE_ZIP_URL="$2"; shift 2 ;;
    --no-start) NO_START=1; shift ;;
    --skip-browser-open) SKIP_BROWSER_OPEN=1; shift ;;
    --non-interactive|--json|--version) shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

need_node() {
  node -e 'const [a,b,c]=process.versions.node.split(".").map(Number); process.exit(a>22 || (a===22 && (b>13 || (b===13 && c>=0))) ? 0 : 1)' >/dev/null 2>&1
}

detect_platform() {
  case "$(uname -s)" in
    Darwin) echo "darwin" ;;
    Linux) echo "linux" ;;
    *) echo "unsupported" ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    arm64|aarch64) echo "arm64" ;;
    x86_64|amd64) echo "x64" ;;
    *) echo "x64" ;;
  esac
}

install_managed_node() {
  local platform arch node_dir index archive url
  platform="$(detect_platform)"
  arch="$(detect_arch)"
  if [[ "$platform" == "unsupported" ]]; then
    echo "Unsupported OS. Install Node.js 22.13+ manually." >&2
    exit 1
  fi
  node_dir="${DISP8CH_DATA_DIR:-$HOME/.local/share/disp8ch}/runtime/node"
  mkdir -p "$node_dir"
  index="$(curl -fsSL https://nodejs.org/dist/latest-v22.x/)"
  archive="$(printf '%s' "$index" | grep -Eo "node-v22\\.[0-9]+\\.[0-9]+-${platform}-${arch}\\.tar\\.xz" | head -n 1)"
  if [[ -z "$archive" ]]; then
    echo "Could not resolve Node.js archive for ${platform}-${arch}." >&2
    exit 1
  fi
  url="https://nodejs.org/dist/latest-v22.x/${archive}"
  echo "Installing managed Node.js from $url"
  curl -fL "$url" -o "$node_dir/node.tar.xz"
  tar -xJf "$node_dir/node.tar.xz" -C "$node_dir" --strip-components=1
  export PATH="$node_dir/bin:$PATH"
}

resolve_source_zip_url() {
  if [[ -n "$SOURCE_ZIP_URL" ]]; then
    printf '%s\n' "$SOURCE_ZIP_URL"
    return 0
  fi
  if [[ "$REPO_URL" =~ ^https://github.com/([^/]+)/([^/.]+)(\.git)?/?$ ]]; then
    printf 'https://github.com/%s/%s/archive/refs/heads/%s.zip\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "$BRANCH"
    return 0
  fi
  return 1
}

install_source_zip() {
  local url tmp zip root backup
  if ! url="$(resolve_source_zip_url)"; then
    echo "Git checkout is unavailable and no source archive URL was provided. Re-run with --repo <github-url>, --source-zip <zip-url>, or run inside a disp8ch checkout." >&2
    exit 1
  fi
  if ! command -v unzip >/dev/null 2>&1; then
    echo "Source archive fallback requires 'unzip'. Install unzip or rerun with Git available." >&2
    exit 1
  fi
  tmp="$(mktemp -d)"
  zip="$tmp/source.zip"
  echo "Downloading disp8ch source archive from $url"
  curl -fL "$url" -o "$zip"
  unzip -q "$zip" -d "$tmp"
  root="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  if [[ -z "$root" ]]; then
    echo "Source archive did not contain a top-level folder." >&2
    rm -rf "$tmp"
    exit 1
  fi
  if [[ -e "$APP_DIR" ]]; then
    backup="${APP_DIR}.backup-$(date +%Y%m%d-%H%M%S)"
    mv "$APP_DIR" "$backup"
  fi
  mkdir -p "$(dirname "$APP_DIR")"
  mv "$root" "$APP_DIR"
  rm -rf "$tmp"
}

if ! need_node; then
  install_managed_node
fi

if ! need_node; then
  echo "Node.js 22.13+ is required and managed Node install failed." >&2
  exit 1
fi

mkdir -p "$(dirname "$APP_DIR")"
if [[ -d "$APP_DIR/.git" ]] && command -v git >/dev/null 2>&1 && git -C "$APP_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C "$APP_DIR" fetch --all --prune
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" pull --ff-only
elif [[ -n "$REPO_URL" && "$(command -v git || true)" != "" ]]; then
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
elif [[ -f "./package.json" && -f "./install.js" ]]; then
  APP_DIR="$(pwd)"
else
  install_source_zip
fi

cd "$APP_DIR"
corepack enable >/dev/null 2>&1 || true
if command -v pnpm >/dev/null 2>&1; then
  PNPM="pnpm"
else
  PNPM="npx -y pnpm@10.30.2"
fi

$PNPM install
$PNPM dpc init --ensure-env

if [[ "$NO_START" == "1" ]]; then
  echo "disp8ch installed at $APP_DIR"
  exit 0
fi

if [[ "$SKIP_BROWSER_OPEN" == "1" ]]; then
  $PNPM runtime:start -- --install-channel script --no-open
else
  $PNPM runtime:start -- --install-channel script
fi
