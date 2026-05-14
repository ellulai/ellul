// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Guardrail Source Bundle — Go source files inlined for build-from-source.
 *
 * Same pattern as warden-source.ts. Source files are written to
 * /opt/ellul/src/guardrail/ and compiled on-server using
 * CGO_ENABLED=1 go build (tree-sitter requires CGO for its C grammars).
 *
 * The bake server already has build-essential (gcc) and Go installed,
 * so CGO_ENABLED=1 works without cross-compilation or Docker.
 */

// Go source files (inlined at build time by tsup text loader)
import guardrailMainGo from "../warden/cmd/guardrail/main.go";
import guardrailGo from "../warden/internal/guardrail/guardrail.go";
import ruleGo from "../warden/internal/guardrail/rule.go";
import treeGo from "../warden/internal/guardrail/tree.go";
import queryLoaderGo from "../warden/internal/guardrail/query_loader.go";
import queryRuleGo from "../warden/internal/guardrail/query_rule.go";
import noDbDropGo from "../warden/internal/guardrail/rules/no_db_drop.go";
import aestheticsGo from "../warden/internal/guardrail/rules/aesthetics_max_depth.go";

// go.mod includes tree-sitter dependency — requires CGO_ENABLED=1
const goMod = `module github.com/ellul.ai/warden

go 1.22

require (
\tgithub.com/elazarl/goproxy v0.0.0-20240618083138-03be62527ccb
\tgithub.com/smacker/go-tree-sitter v0.0.0-20240827094217-dd81d9e9be82
\tgopkg.in/yaml.v3 v3.0.1
)
`;

interface SourceFile {
  path: string; // relative to guardrail root (shares module with warden)
  content: string;
}

const sourceFiles: SourceFile[] = [
  { path: "go.mod", content: goMod },
  { path: "cmd/guardrail/main.go", content: guardrailMainGo },
  { path: "internal/guardrail/guardrail.go", content: guardrailGo },
  { path: "internal/guardrail/rule.go", content: ruleGo },
  { path: "internal/guardrail/tree.go", content: treeGo },
  { path: "internal/guardrail/query_loader.go", content: queryLoaderGo },
  { path: "internal/guardrail/query_rule.go", content: queryRuleGo },
  { path: "internal/guardrail/rules/no_db_drop.go", content: noDbDropGo },
  { path: "internal/guardrail/rules/aesthetics_max_depth.go", content: aestheticsGo },
];

/**
 * Generate bash commands to write the guardrail Go source tree and build the binary.
 * Returns a bash snippet that:
 * 1. Creates /opt/ellul/src/guardrail/ directory structure
 * 2. Writes all Go source files using heredocs
 * 3. Runs `go mod tidy && CGO_ENABLED=1 go build` to produce /usr/local/bin/guardrail
 *
 * Key difference from warden: CGO_ENABLED=1 (tree-sitter grammars are C code).
 * The bake server has gcc from build-essential, so CGO works natively.
 * No Docker, no zig, no cross-compilation — builds on the target arch directly.
 */
export function generateGuardrailBuildFromSource(): string {
  const writeCommands = sourceFiles
    .map((f) => {
      const dir = f.path.includes("/")
        ? f.path.substring(0, f.path.lastIndexOf("/"))
        : "";
      const mkdirCmd = dir
        ? `    mkdir -p /opt/ellul/src/guardrail/${dir}`
        : "";
      const delim = `GUARDSRC_${f.path.replace(/[/.]/g, "_").toUpperCase()}`;
      return `${mkdirCmd ? mkdirCmd + "\n" : ""}    cat > /opt/ellul/src/guardrail/${f.path} << '${delim}'
${f.content.trimEnd()}
${delim}`;
    })
    .join("\n\n");

  return `
    # Build Guardrail from Go source
    log "Building Guardrail from source..."
    mkdir -p /opt/ellul/src/guardrail

${writeCommands}

    # Build binary — install Go if not available
    GO_BIN=$(command -v go 2>/dev/null || echo "/usr/local/go/bin/go")
    GO_INSTALLED_HERE=false
    if [ ! -x "$GO_BIN" ]; then
      log "Go not found, downloading for Guardrail build..."
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
        log "Go installed for Guardrail build"
      else
        log "ERROR: Failed to download Go compiler"
      fi
    fi
    if [ -x "$GO_BIN" ]; then
      cd /opt/ellul/src/guardrail
      export HOME=/root
      export GOPATH=/tmp/go-build
      export GOMODCACHE=/tmp/go-build/pkg/mod
      mkdir -p "$GOMODCACHE"
      $GO_BIN mod tidy 2>&1 || log "WARNING: go mod tidy failed"
      # CGO_ENABLED=1 — tree-sitter grammars are C code compiled via gcc.
      # The bake server has build-essential installed (gcc available).
      CGO_ENABLED=1 $GO_BIN build -o /usr/local/bin/guardrail ./cmd/guardrail 2>&1 || log "WARNING: go build failed"
      if [ -x /usr/local/bin/guardrail ]; then
        log "Guardrail built from source successfully"
      else
        log "ERROR: Guardrail build from source failed"
      fi
      rm -rf /tmp/go-build
      cd /
      if [ "$GO_INSTALLED_HERE" = "true" ]; then
        rm -rf /usr/local/go
        log "Go compiler removed after Guardrail build"
      fi
    else
      log "ERROR: No Go compiler available — cannot build Guardrail from source"
    fi`;
}
