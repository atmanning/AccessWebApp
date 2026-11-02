#!/usr/bin/env bash
# Access Web installer for macOS and Linux. No admin rights and no questions.
#
#   curl -fsSL https://raw.githubusercontent.com/atmanning/AccessWebApp/main/install.sh | bash
#
# Run the same command again to update; your data folder is kept.
# It downloads private copies of Node.js, Java and Maven into the app folder (nothing is installed
# system-wide), builds the app, adds a launcher, and starts it.
#
# Options (environment variables, or flags after `bash -s --`):
#   ACCESSWEB_DIR=path      --dir path      install folder (default ~/AccessWeb)
#   ACCESSWEB_NO_START=1    --no-start      don't start the app when done
#   ACCESSWEB_SOURCE=file   --source file   install from a downloaded .tar.gz of the repo (offline/USB)
#   ACCESSWEB_BRANCH=name                   GitHub branch to install (default main)
set -euo pipefail

REPO="atmanning/AccessWebApp"
BRANCH="${ACCESSWEB_BRANCH:-main}"
INSTALL_DIR="${ACCESSWEB_DIR:-$HOME/AccessWeb}"
SOURCE="${ACCESSWEB_SOURCE:-}"
NO_START="${ACCESSWEB_NO_START:-}"
NODE_MAJOR=22
JAVA_MAJOR=21
MAVEN_VERSION=3.9.11

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --source) SOURCE="$2"; shift 2 ;;
    --no-start) NO_START=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mNote:\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }
download() { curl -fL --retry 3 --progress-bar -o "$2" "$1"; }
fetch()    { curl -fsSL --retry 3 "$1"; }
hash_of()  { if command -v sha"$1"sum >/dev/null; then sha"$1"sum "$2"; else shasum -a "$1" "$2"; fi | cut -d' ' -f1; }
verify()   { [[ "$(hash_of "$1" "$2")" == "$(tr 'A-F' 'a-f' <<<"$3")" ]] || die "Checksum mismatch for $(basename "$2"). Try again."; }

# ---------------------------------------------------------------- checks
case "$(uname -s)" in
  Darwin) OS=mac;   NODE_OS=darwin ;;
  Linux)  OS=linux; NODE_OS=linux ;;
  *) die "This installer is for macOS and Linux. On Windows use install.ps1." ;;
esac
case "$(uname -m)" in
  x86_64|amd64)  NODE_ARCH=x64;   JDK_ARCH=x64 ;;
  arm64|aarch64) NODE_ARCH=arm64; JDK_ARCH=aarch64 ;;
  *) die "Unsupported processor: $(uname -m)" ;;
esac
for t in curl tar; do command -v "$t" >/dev/null || die "'$t' is required. Install it and run this again."; done

INSTALL_DIR="${INSTALL_DIR%/}"
MARKER="$INSTALL_DIR/.accessweb-install"
RT="$INSTALL_DIR/.runtime"
if [[ -d "$INSTALL_DIR" && -n "$(ls -A "$INSTALL_DIR")" && ! -f "$MARKER" ]]; then
  die "$INSTALL_DIR already exists and wasn't made by this installer. Choose another folder with --dir."
fi
mkdir -p "$RT" "$INSTALL_DIR/data"
touch "$MARKER"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

say "Installing Access Web into $INSTALL_DIR"

# Stop a running copy so its files can be replaced.
pkill -f "$INSTALL_DIR/server/dist/server/src/index.js" 2>/dev/null && { say "Stopped the running copy"; sleep 1; } || true

# ---------------------------------------------------------------- runtimes
# Each runtime is skipped when the installed version is already current, and kept as-is when the
# download site can't be reached (so updates work offline if the runtimes are already there).

install_node() {
  local sums line file
  sums="$(fetch "https://nodejs.org/dist/latest-v$NODE_MAJOR.x/SHASUMS256.txt" 2>/dev/null)" || sums=""
  if [[ -z "$sums" ]]; then
    [[ -x "$RT/node/bin/node" ]] && { warn "Couldn't check for a newer Node.js; keeping the current one."; return; }
    die "Couldn't reach nodejs.org to download Node.js."
  fi
  line="$(grep -E " node-v[0-9.]+-$NODE_OS-$NODE_ARCH\.tar\.gz$" <<<"$sums" | head -1)"
  [[ -n "$line" ]] || die "No Node.js $NODE_MAJOR build for $NODE_OS-$NODE_ARCH."
  file="${line##* }"
  if [[ "$(cat "$RT/node.version" 2>/dev/null)" == "$file" ]]; then say "Node.js is up to date"; return; fi
  say "Downloading Node.js ($file)"
  download "https://nodejs.org/dist/latest-v$NODE_MAJOR.x/$file" "$TMP/node.tgz"
  verify 256 "$TMP/node.tgz" "${line%% *}"
  mkdir -p "$TMP/node" && tar -xzf "$TMP/node.tgz" -C "$TMP/node" --strip-components 1
  rm -rf "$RT/node" && mv "$TMP/node" "$RT/node" && echo "$file" >"$RT/node.version"
}

install_java() {
  local info name link sum home
  info="$(fetch "https://api.adoptium.net/v3/assets/latest/$JAVA_MAJOR/hotspot?os=$OS&architecture=$JDK_ARCH&image_type=jdk&vendor=eclipse" 2>/dev/null)" || info=""
  if [[ -z "$info" ]]; then
    [[ -x "$RT/java/bin/java" ]] && { warn "Couldn't check for a newer Java; keeping the current one."; return; }
    die "Couldn't reach api.adoptium.net to download Java."
  fi
  read -r name link sum < <("$RT/node/bin/node" -e '
    const p = JSON.parse(require("fs").readFileSync(0, "utf8"))[0].binary.package;
    console.log(p.name, p.link, p.checksum);' <<<"$info")
  if [[ "$(cat "$RT/java.version" 2>/dev/null)" == "$name" ]]; then say "Java is up to date"; return; fi
  say "Downloading Java $JAVA_MAJOR ($name)"
  download "$link" "$TMP/jdk.tgz"
  verify 256 "$TMP/jdk.tgz" "$sum"
  mkdir -p "$TMP/jdk" && tar -xzf "$TMP/jdk.tgz" -C "$TMP/jdk" --strip-components 1
  home="$TMP/jdk"; [[ -d "$home/Contents/Home" ]] && home="$home/Contents/Home"   # macOS bundle layout
  rm -rf "$RT/java" && mv "$home" "$RT/java" && echo "$name" >"$RT/java.version"
}

install_maven() {
  [[ "$(cat "$RT/maven.version" 2>/dev/null)" == "$MAVEN_VERSION" ]] && return
  local base="https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/$MAVEN_VERSION/apache-maven-$MAVEN_VERSION-bin.tar.gz"
  say "Downloading Maven $MAVEN_VERSION"
  download "$base" "$TMP/maven.tgz"
  verify 512 "$TMP/maven.tgz" "$(fetch "$base.sha512" | cut -d' ' -f1)"
  mkdir -p "$TMP/maven" && tar -xzf "$TMP/maven.tgz" -C "$TMP/maven" --strip-components 1
  rm -rf "$RT/maven" && mv "$TMP/maven" "$RT/maven" && echo "$MAVEN_VERSION" >"$RT/maven.version"
}

install_node
install_java
install_maven
export PATH="$RT/node/bin:$RT/java/bin:$RT/maven/bin:$PATH"
export JAVA_HOME="$RT/java"

# ---------------------------------------------------------------- app
mkdir -p "$TMP/src"
if [[ -n "$SOURCE" ]]; then
  say "Using app files from $SOURCE"
  tar -xzf "$SOURCE" -C "$TMP/src" --strip-components 1
else
  say "Downloading the latest Access Web ($BRANCH)"
  download "https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz" "$TMP/app.tgz"
  tar -xzf "$TMP/app.tgz" -C "$TMP/src" --strip-components 1
fi
[[ -f "$TMP/src/package.json" && -f "$TMP/src/start-local.sh" ]] || die "The downloaded files don't look like Access Web."

# Swap the app files, keeping data/ and the runtimes. The previous version is kept until the
# new one builds, and put back if the build fails.
keep() { case "$1" in data|.runtime|.accessweb-install|.previous) return 0 ;; *) return 1 ;; esac; }
rm -rf "$INSTALL_DIR/.previous"; mkdir "$INSTALL_DIR/.previous"
move_app_files() {   # move_app_files FROM TO
  local f
  for f in "$1"/* "$1"/.[!.]*; do
    if [[ -e "$f" ]] && ! keep "$(basename "$f")"; then mv "$f" "$2/"; fi
  done
}
move_app_files "$INSTALL_DIR" "$INSTALL_DIR/.previous"
move_app_files "$TMP/src" "$INSTALL_DIR"

build_app() {
  cd "$INSTALL_DIR" || return 1
  say "Installing packages"
  npm ci --no-audit --no-fund --loglevel=error || return 1
  say "Building the app"
  npm run build --silent || return 1
  say "Building the Access (.accdb) exporter"
  mvn -B -q -ntp -f exporter/pom.xml package -DskipTests ||
    warn "The exporter didn't build, so .accdb import/export won't work. Everything else will; run the installer again later to retry."
  npm prune --omit=dev --no-audit --no-fund --loglevel=error || return 1
}

if ! build_app; then
  if [[ -n "$(ls -A "$INSTALL_DIR/.previous")" ]]; then
    rm -rf "$TMP/failed" && mkdir "$TMP/failed"
    move_app_files "$INSTALL_DIR" "$TMP/failed"
    move_app_files "$INSTALL_DIR/.previous" "$INSTALL_DIR"
    rmdir "$INSTALL_DIR/.previous"
    die "The build failed, so your previous version was put back. The messages above say why."
  fi
  rmdir "$INSTALL_DIR/.previous" 2>/dev/null || true
  die "The build failed. The messages above say why."
fi
rm -rf "$INSTALL_DIR/.previous"
chmod +x "$INSTALL_DIR/start-local.sh"

# ---------------------------------------------------------------- launcher
if [[ "$OS" == mac ]]; then
  launcher="$HOME/Desktop/Access Web.command"
  mkdir -p "$HOME/Desktop"
  printf '#!/bin/bash\nexec "%s/start-local.sh"\n' "$INSTALL_DIR" >"$launcher" && chmod +x "$launcher"
  say "Added 'Access Web' to your Desktop"
else
  apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  mkdir -p "$apps"
  cat >"$apps/access-web.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Access Web
Comment=Start Access Web and open it in your browser
Exec="$INSTALL_DIR/start-local.sh"
Terminal=true
Categories=Office;Database;
EOF
  say "Added 'Access Web' to your applications menu"
fi

echo
say "Access Web is installed. Your databases are kept in $INSTALL_DIR/data"
echo "    Start it any time with: $INSTALL_DIR/start-local.sh"
echo "    Update it by running this installer again."
echo
if [[ -z "$NO_START" ]]; then
  exec "$INSTALL_DIR/start-local.sh"
fi
