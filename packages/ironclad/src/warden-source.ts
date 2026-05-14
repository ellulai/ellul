// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Warden Source Bundle — Go source files inlined for build-from-source fallback.
 *
 * If the pre-built warden binary can't be downloaded (WARDEN_BINARY_URL not set
 * or download fails), these source files are written to /opt/ellul/src/warden/
 * and compiled on-server using `go build`.
 */

// Go source files (inlined at build time by tsup text loader)
import mainGo from "../warden/cmd/warden/main.go";
import caGo from "../warden/internal/ca/ca.go";
import resolverGo from "../warden/internal/dns/resolver.go";
import healthGo from "../warden/internal/health/health.go";
import mitmGo from "../warden/internal/proxy/mitm.go";
import rulesGo from "../warden/internal/proxy/rules.go";
import certgenGo from "../warden/internal/proxy/certgen.go";
import transparentGo from "../warden/internal/proxy/transparent.go";
import transportGo from "../warden/internal/proxy/transport.go";
import bucketGo from "../warden/internal/throttle/bucket.go";

// go.mod is plain text — import as .go won't work since it's .mod extension.
// We'll inline it directly since it's tiny and rarely changes.
const goMod = `module github.com/ellul.ai/warden

go 1.22

require (
\tgithub.com/elazarl/goproxy v0.0.0-20240618083138-03be62527ccb
\tgopkg.in/yaml.v3 v3.0.1
)
`;

interface SourceFile {
  path: string; // relative to warden root
  content: string;
}

const sourceFiles: SourceFile[] = [
  { path: "go.mod", content: goMod },
  { path: "cmd/warden/main.go", content: mainGo },
  { path: "internal/ca/ca.go", content: caGo },
  { path: "internal/dns/resolver.go", content: resolverGo },
  { path: "internal/health/health.go", content: healthGo },
  { path: "internal/proxy/certgen.go", content: certgenGo },
  { path: "internal/proxy/mitm.go", content: mitmGo },
  { path: "internal/proxy/rules.go", content: rulesGo },
  { path: "internal/proxy/transparent.go", content: transparentGo },
  { path: "internal/proxy/transport.go", content: transportGo },
  { path: "internal/throttle/bucket.go", content: bucketGo },
];

/**
 * Generate bash commands to write the warden Go source tree and build the binary.
 * Returns a bash snippet that:
 * 1. Creates /opt/ellul/src/warden/ directory structure
 * 2. Writes all Go source files using heredocs
 * 3. Runs `go mod tidy && go build` to produce /usr/local/bin/warden
 */
export function generateWardenBuildFromSource(): string {
  const writeCommands = sourceFiles
    .map((f) => {
      const dir = f.path.includes("/")
        ? f.path.substring(0, f.path.lastIndexOf("/"))
        : "";
      const mkdirCmd = dir
        ? `    mkdir -p /opt/ellul/src/warden/${dir}`
        : "";
      // Use a unique heredoc delimiter per file to avoid conflicts
      const delim = `WARDENSRC_${f.path.replace(/[/.]/g, "_").toUpperCase()}`;
      return `${mkdirCmd ? mkdirCmd + "\n" : ""}    cat > /opt/ellul/src/warden/${f.path} << '${delim}'
${f.content.trimEnd()}
${delim}`;
    })
    .join("\n\n");

  return `
    # Build Warden from Go source (fallback when binary download fails)
    log "Building Warden from source..."
    mkdir -p /opt/ellul/src/warden

${writeCommands}

    # Build binary — install Go if not available
    GO_BIN=$(command -v go 2>/dev/null || echo "/usr/local/go/bin/go")
    GO_INSTALLED_HERE=false
    if [ ! -x "$GO_BIN" ]; then
      log "Go not found, downloading for Warden build..."
      GO_ARCH=$(uname -m)
      case $GO_ARCH in
        x86_64)  GO_ARCH="amd64" ;;
        aarch64) GO_ARCH="arm64" ;;
      esac
      if curl -fsSL "https://go.dev/dl/go1.22.12.linux-$GO_ARCH.tar.gz" -o /tmp/go.tar.gz; then
        tar -C /usr/local -xzf /tmp/go.tar.gz
        rm -f /tmp/go.tar.gz
        GO_BIN="/usr/local/go/bin/go"
        GO_INSTALLED_HERE=true
        log "Go installed for Warden build"
      else
        log "ERROR: Failed to download Go compiler"
      fi
    fi
    if [ -x "$GO_BIN" ]; then
      cd /opt/ellul/src/warden
      # Set HOME/GOPATH/GOMODCACHE explicitly — cloud-init may not have HOME set,
      # causing "module cache not found: neither GOMODCACHE nor GOPATH is set"
      export HOME=/root
      export GOPATH=/tmp/go-build
      export GOMODCACHE=/tmp/go-build/pkg/mod
      mkdir -p "$GOMODCACHE"
      $GO_BIN mod tidy 2>&1 || log "WARNING: go mod tidy failed"
      CGO_ENABLED=0 $GO_BIN build -o /usr/local/bin/warden ./cmd/warden 2>&1 || log "WARNING: go build failed"
      if [ -x /usr/local/bin/warden ]; then
        log "Warden built from source successfully"
      else
        log "ERROR: Warden build from source failed"
      fi
      rm -rf /tmp/go-build
      cd /
      # Clean up Go installation if we installed it (saves ~500MB)
      if [ "$GO_INSTALLED_HERE" = "true" ]; then
        rm -rf /usr/local/go
        log "Go compiler removed after Warden build"
      fi
    else
      log "ERROR: No Go compiler available — cannot build Warden from source"
    fi`;
}
