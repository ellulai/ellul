#!/bin/bash
set -e

RUNTIME="$1"
LOGFILE="/var/log/ellul-runtime-install.log"

log() { echo "[$(date -Iseconds)] $1" | tee -a "$LOGFILE"; }

if [ -z "$RUNTIME" ]; then
  echo "Usage: ellul-install-runtime <runtime>" >&2
  exit 1
fi

# Determine SVC_USER from existing users
if id -u dev >/dev/null 2>&1; then
  SVC_USER="dev"
elif id -u coder >/dev/null 2>&1; then
  SVC_USER="coder"
else
  SVC_USER="dev"
fi
SVC_HOME="/home/$SVC_USER"

ARCH=$(dpkg --print-architecture 2>/dev/null || echo "amd64")

case "$RUNTIME" in
  ruby)
    command -v ruby >/dev/null 2>&1 && { log "Ruby already installed"; exit 0; }
    log "Installing Ruby..."
    apt-get update -o DPkg::Lock::Timeout=60
    apt-get install -y -o DPkg::Lock::Timeout=60 __APT_RUBY__
    gem install bundler
    log "Ruby $(ruby --version) installed"
    ;;
  go)
    command -v go >/dev/null 2>&1 && { log "Go already installed"; exit 0; }
    log "Installing Go..."
    GO_VERSION="__GO_VERSION__"
    rm -rf /usr/local/go
    GO_TARBALL="/tmp/go-install.tar.gz"
    for _go_attempt in 1 2 3; do
      if curl -fsSL --connect-timeout 20 --max-time 180 --retry 2 \
        "https://go.dev/dl/${GO_VERSION}.linux-${ARCH}.tar.gz" -o "$GO_TARBALL" \
        && gzip -t "$GO_TARBALL" 2>/dev/null \
        && tar -C /usr/local -xzf "$GO_TARBALL"; then
        rm -f "$GO_TARBALL"
        break
      fi
      log "WARN: Go download attempt $_go_attempt/3 failed"
      rm -f "$GO_TARBALL"
      sleep 5
    done
    echo 'export PATH=/usr/local/go/bin:$PATH' > /etc/profile.d/golang.sh
    [ -x /usr/local/go/bin/go ] && log "Go $(/usr/local/go/bin/go version) installed" || { log "ERROR: Go install failed"; exit 1; }
    ;;
  rust)
    if runuser -l "$SVC_USER" -c 'command -v cargo' >/dev/null 2>&1; then
      log "Rust already installed"
      exit 0
    fi
    log "Installing Rust for $SVC_USER..."
    RUST_SCRIPT="/tmp/rustup-install.sh"
    for _rust_attempt in 1 2 3; do
      if curl -fsSL --connect-timeout 20 --max-time 60 --retry 2 --proto '=https' --tlsv1.2 \
        "https://sh.rustup.rs" -o "$RUST_SCRIPT" && [ -s "$RUST_SCRIPT" ] \
        && head -1 "$RUST_SCRIPT" | grep -q "^#!/"; then
        runuser -l "$SVC_USER" -c "sh $RUST_SCRIPT -y --default-toolchain __RUST_VERSION__" && break
      fi
      log "WARN: Rust install attempt $_rust_attempt/3 failed"
      rm -f "$RUST_SCRIPT"
      sleep 5
    done
    rm -f "$RUST_SCRIPT"
    runuser -l "$SVC_USER" -c 'command -v cargo' >/dev/null 2>&1 && log "Rust installed for $SVC_USER" || log "ERROR: Rust install failed"
    ;;
  elixir)
    command -v elixir >/dev/null 2>&1 && { log "Elixir already installed"; exit 0; }
    log "Installing Elixir..."
    apt-get update -o DPkg::Lock::Timeout=60
    apt-get install -y -o DPkg::Lock::Timeout=60 __APT_ELIXIR__
    log "Elixir $(elixir --version | tail -1) installed"
    ;;
  php)
    command -v php >/dev/null 2>&1 && { log "PHP already installed"; exit 0; }
    log "Installing PHP..."
    apt-get update -o DPkg::Lock::Timeout=60
    apt-get install -y -o DPkg::Lock::Timeout=60 __APT_PHP__
    # Composer: download-then-execute (never pipe to php)
    COMPOSER_INSTALLER="/tmp/composer-setup.php"
    if curl -fsSL --connect-timeout 15 --max-time 60 --retry 2 \
      "https://getcomposer.org/installer" -o "$COMPOSER_INSTALLER" \
      && [ -s "$COMPOSER_INSTALLER" ]; then
      php "$COMPOSER_INSTALLER" --install-dir=/usr/local/bin --filename=composer --version=__COMPOSER_VERSION__
    else
      log "WARN: Composer download failed"
    fi
    rm -f "$COMPOSER_INSTALLER"
    log "PHP $(php --version | head -1) installed"
    ;;
  dart)
    command -v dart >/dev/null 2>&1 && { log "Dart already installed"; exit 0; }
    if [ "$ARCH" != "amd64" ]; then
      log "ERROR: Dart APT packages only available for amd64 (this is $ARCH)"
      echo "Dart SDK is not available for $ARCH via APT" >&2
      exit 1
    fi
    log "Installing Dart..."
    apt-get update -o DPkg::Lock::Timeout=60
    apt-get install -y -o DPkg::Lock::Timeout=60 apt-transport-https
    rm -f /usr/share/keyrings/dart.gpg  # idempotent: remove stale keyring
    curl -fsSL https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --batch --yes --dearmor -o /usr/share/keyrings/dart.gpg
    echo "deb [signed-by=/usr/share/keyrings/dart.gpg arch=amd64] https://storage.googleapis.com/dart-archive/channels/stable/release/latest/linux_packages stable main" > /etc/apt/sources.list.d/dart_stable.list
    apt-get update -o DPkg::Lock::Timeout=60
    apt-get install -y -o DPkg::Lock::Timeout=60 __APT_DART__
    log "Dart installed"
    ;;
  flutter)
    command -v flutter >/dev/null 2>&1 && { log "Flutter already installed"; exit 0; }
    log "Installing Flutter..."
    # Clean up corrupted partial installs
    if [ -d /opt/flutter ] && ! /opt/flutter/bin/flutter --version >/dev/null 2>&1; then
      log "Removing corrupted Flutter install..."
      rm -rf /opt/flutter
    fi
    if [ ! -d /opt/flutter ]; then
      git clone --depth 1 https://github.com/flutter/flutter.git -b __FLUTTER_VERSION__ /opt/flutter
    fi
    /opt/flutter/bin/flutter precache --web
    chmod -R a+rx /opt/flutter
    echo 'export PATH=/opt/flutter/bin:$PATH' > /etc/profile.d/flutter.sh
    log "Flutter installed"
    ;;
  dotnet)
    command -v dotnet >/dev/null 2>&1 && { log ".NET already installed"; exit 0; }
    log "Installing .NET SDK 8.0..."
    DOTNET_SCRIPT="/tmp/dotnet-install.sh"
    curl -fsSL --connect-timeout 15 --max-time 60 --retry 2 \
      https://dot.net/v1/dotnet-install.sh -o "$DOTNET_SCRIPT"
    if [ ! -s "$DOTNET_SCRIPT" ] || ! head -1 "$DOTNET_SCRIPT" | grep -q "^#!/"; then
      log "ERROR: dotnet install script download failed or invalid"
      rm -f "$DOTNET_SCRIPT"
      exit 1
    fi
    chmod +x "$DOTNET_SCRIPT"
    "$DOTNET_SCRIPT" --channel __DOTNET_VERSION__ --install-dir /usr/share/dotnet
    rm -f "$DOTNET_SCRIPT"
    ln -sf /usr/share/dotnet/dotnet /usr/local/bin/dotnet
    rm -f /tmp/dotnet-install.sh
    # System-wide PATH + DOTNET_ROOT for all users
    cat > /etc/profile.d/dotnet.sh << 'DOTNETPROFILE'
export DOTNET_ROOT=/usr/share/dotnet
export PATH=/usr/share/dotnet:$PATH
export DOTNET_CLI_TELEMETRY_OPTOUT=1
DOTNETPROFILE
    log ".NET $(/usr/share/dotnet/dotnet --version) installed"
    ;;
  java)
    command -v java >/dev/null 2>&1 && { log "Java already installed"; exit 0; }
    log "Installing Eclipse Temurin JDK __JAVA_VERSION__..."
    apt-get update -o DPkg::Lock::Timeout=60
    apt-get install -y -o DPkg::Lock::Timeout=60 __APT_JAVA_PREREQS__
    # Adoptium GPG key + repo
    curl -fsSL https://packages.adoptium.net/artifactory/api/gpg/key/public | gpg --batch --yes --dearmor -o /usr/share/keyrings/adoptium.gpg
    echo "deb [signed-by=/usr/share/keyrings/adoptium.gpg] https://packages.adoptium.net/artifactory/deb noble main" > /etc/apt/sources.list.d/adoptium.list
    apt-get update -o DPkg::Lock::Timeout=60
    apt-get install -y -o DPkg::Lock::Timeout=60 __APT_JAVA__
    # System-wide JAVA_HOME
    JAVA_HOME=$(dirname $(dirname $(readlink -f $(which java))))
    cat > /etc/profile.d/java.sh << JAVAPROFILE
export JAVA_HOME=$JAVA_HOME
export PATH=\$JAVA_HOME/bin:\$PATH
JAVAPROFILE
    log "Java $(java -version 2>&1 | head -1) installed"
    ;;
  bun)
    command -v bun >/dev/null 2>&1 && { log "Bun already installed"; exit 0; }
    log "Installing Bun..."
    BUN_SCRIPT="/tmp/bun-install.sh"
    for _bun_attempt in 1 2 3; do
      if curl -fsSL --connect-timeout 20 --max-time 60 --retry 2 \
        "https://bun.sh/install" -o "$BUN_SCRIPT" && [ -s "$BUN_SCRIPT" ] \
        && head -1 "$BUN_SCRIPT" | grep -q "^#!/"; then
        BUN_VERSION=__BUN_VERSION__ bash "$BUN_SCRIPT" && break
      fi
      log "WARN: Bun install attempt $_bun_attempt/3 failed"
      rm -f "$BUN_SCRIPT"
      sleep 5
    done
    rm -f "$BUN_SCRIPT"
    # Move to system-wide location
    if [ -d "$HOME/.bun" ]; then
      mv "$HOME/.bun/bin/bun" /usr/local/bin/bun
      chmod +x /usr/local/bin/bun
      rm -rf "$HOME/.bun"
    fi
    cat > /etc/profile.d/bun.sh << 'BUNPROFILE'
export BUN_INSTALL=/usr/local
export PATH=/usr/local/bin:$PATH
BUNPROFILE
    log "Bun $(/usr/local/bin/bun --version) installed"
    ;;
  *)
    log "ERROR: Unknown runtime: $RUNTIME"
    echo "Unknown runtime: $RUNTIME" >&2
    echo "Allowed: ruby, go, rust, elixir, php, dart, flutter, dotnet, java, bun" >&2
    exit 1
    ;;
esac

log "Runtime $RUNTIME installation complete"
