// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Guardrail — Empty Vessel AST Execution Interceptor
//
// This binary contains ZERO hardcoded policy. It is a pure execution engine
// that enforces whatever instructions it receives from two sources:
//
//   1. Tree-sitter queries (.scm files) — pattern-matching rules loaded from
//      --rules directories. These come from the central PostgreSQL database
//      via the sync cache, plus any user-local rules.
//
//   2. Engine analyzers config (.json) — activates built-in geometric analyzers
//      that cannot be expressed as tree-sitter queries (e.g., AST depth limits).
//      Loaded from --analyzers flag. Config synced from the central database.
//
// The Source of Truth is the central PostgreSQL database. Rules and analyzer
// configs are synced to the VPS by sovereign-shield.
//
// If no rules AND no analyzers are loaded from any source, the binary returns
// NO_POLICIES_LOADED and exits with code 1 (fail-closed). The system is
// "Safe by Silence" — it refuses to permit execution until it receives its
// instructions from the Source of Truth.

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/ellul.ai/warden/internal/guardrail"
	"github.com/ellul.ai/warden/internal/guardrail/rules"
)

func main() {
	if len(os.Args) < 2 || os.Args[1] != "scan" {
		fmt.Fprintf(os.Stderr, "Usage: guardrail scan --dir <path> --rules <path> [--rules <path> ...] [--analyzers <path>]\n")
		os.Exit(2)
	}

	var dir string
	var rulesDirs []string
	var analyzersPath string

	args := os.Args[2:]
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--dir":
			if i+1 >= len(args) {
				fmt.Fprintf(os.Stderr, "Error: --dir requires a value\n")
				os.Exit(2)
			}
			i++
			dir = args[i]
		case "--rules":
			if i+1 >= len(args) {
				fmt.Fprintf(os.Stderr, "Error: --rules requires a value\n")
				os.Exit(2)
			}
			i++
			rulesDirs = append(rulesDirs, args[i])
		case "--analyzers":
			if i+1 >= len(args) {
				fmt.Fprintf(os.Stderr, "Error: --analyzers requires a value\n")
				os.Exit(2)
			}
			i++
			analyzersPath = args[i]
		default:
			if strings.HasPrefix(args[i], "--dir=") {
				dir = strings.TrimPrefix(args[i], "--dir=")
			} else if strings.HasPrefix(args[i], "--rules=") {
				rulesDirs = append(rulesDirs, strings.TrimPrefix(args[i], "--rules="))
			} else if strings.HasPrefix(args[i], "--analyzers=") {
				analyzersPath = strings.TrimPrefix(args[i], "--analyzers=")
			} else {
				fmt.Fprintf(os.Stderr, "Error: unknown flag %q\n", args[i])
				os.Exit(2)
			}
		}
	}

	if dir == "" {
		fmt.Fprintf(os.Stderr, "Error: --dir is required\n")
		os.Exit(2)
	}

	var allRules []guardrail.Rule

	// Load .scm pattern rules from all --rules directories.
	for _, rulesDir := range rulesDirs {
		loaded, err := guardrail.LoadUserRules(rulesDir)
		if err != nil {
			failClosed(fmt.Sprintf("Failed to load rules from %s: %v", rulesDir, err))
			return
		}
		allRules = append(allRules, loaded...)
	}

	// Load engine analyzers from --analyzers config.
	// Engine analyzers are geometric computations over the AST that cannot
	// be expressed as tree-sitter pattern queries (e.g., nesting depth limits).
	// The config file is synced from the central database alongside .scm rules.
	if analyzersPath != "" {
		engineRules, err := loadAnalyzers(analyzersPath)
		if err != nil {
			failClosed(fmt.Sprintf("Failed to load analyzers from %s: %v", analyzersPath, err))
			return
		}
		allRules = append(allRules, engineRules...)
	}

	// Empty Vessel fail-closed: no rules from any source = block execution.
	// Safe by Silence — refuses to move until the Source of Truth provides policy.
	if len(allRules) == 0 {
		result := guardrail.ScanResult{
			Blocked: true,
			Error:   "NO_POLICIES_LOADED: Guardrail has no rules to enforce. The sync cache is empty or no --rules directories were provided. Execution is blocked until the central policy sync completes.",
		}
		json.NewEncoder(os.Stdout).Encode(result)
		os.Exit(1)
	}

	scanner := guardrail.NewScanner(allRules...)
	result := scanner.ScanDir(dir)

	json.NewEncoder(os.Stdout).Encode(result)

	if result.Blocked {
		os.Exit(1)
	}
}

// AnalyzersConfig is the JSON schema for engine analyzer activation.
// Synced from the central database to the VPS.
type AnalyzersConfig struct {
	AestheticsMaxDepth *AestheticsMaxDepthConfig `json:"aesthetics_max_depth,omitempty"`
}

type AestheticsMaxDepthConfig struct {
	Enabled   bool `json:"enabled"`
	Threshold int  `json:"threshold"`
}

// loadAnalyzers reads the analyzers JSON config and instantiates the
// corresponding built-in Go rules. Only activated analyzers are returned.
func loadAnalyzers(path string) ([]guardrail.Rule, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, nil // no config file = no engine analyzers
	}
	if err != nil {
		return nil, fmt.Errorf("read analyzers config: %w", err)
	}

	var config AnalyzersConfig
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, fmt.Errorf("parse analyzers config: %w", err)
	}

	var result []guardrail.Rule

	if config.AestheticsMaxDepth != nil && config.AestheticsMaxDepth.Enabled {
		threshold := config.AestheticsMaxDepth.Threshold
		if threshold <= 0 {
			threshold = 2
		}
		result = append(result, &rules.AestheticsMaxDepth{Threshold: threshold})
	}

	return result, nil
}

func failClosed(errMsg string) {
	result := guardrail.ScanResult{
		Blocked: true,
		Error:   errMsg,
	}
	json.NewEncoder(os.Stdout).Encode(result)
	os.Exit(1)
}
