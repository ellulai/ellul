// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

package guardrail

import (
	"io/fs"
	"os"
	"path/filepath"
)

// ScanResult is the output of scanning a workspace.
type ScanResult struct {
	Blocked      bool      `json:"blocked"`
	Findings     []Finding `json:"findings"`
	Error        string    `json:"error,omitempty"`
	FilesScanned int       `json:"files_scanned"`
}

// Scanner holds registered rules and runs them against source files.
type Scanner struct {
	rules []Rule
}

// NewScanner creates a scanner with the given rules.
func NewScanner(rules ...Rule) *Scanner {
	return &Scanner{rules: rules}
}

// skipDirs contains directories to skip during workspace walking.
var skipDirs = map[string]bool{
	"vendor":       true,
	"node_modules": true,
	".git":         true,
	"testdata":     true,
	"dist":         true,
	"build":        true,
	"__pycache__":  true,
	".next":        true,
	".vite":        true,
}

// ScanDir walks a directory, parses all recognized source files, and runs
// all applicable rules against each parsed tree.
//
// Fail-closed semantics:
//   - If a file cannot be read: contributes a SeverityError finding, result is Blocked.
//   - If tree-sitter parse returns nil tree: contributes a SeverityError finding.
//   - If any rule returns a SeverityError finding: result is Blocked.
//   - Tree-sitter ERROR nodes in the tree: rules still run on valid subtrees.
func (s *Scanner) ScanDir(dir string) ScanResult {
	result := ScanResult{}

	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}

		if d.IsDir() {
			if skipDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}

		lang := DetectLanguage(path)
		if lang == LangUnknown {
			return nil
		}

		src, err := os.ReadFile(path)
		if err != nil {
			result.Findings = append(result.Findings, Finding{
				Rule:     "scanner",
				Message:  "Failed to read file: " + err.Error(),
				File:     relPath(dir, path),
				Severity: SeverityError,
			})
			result.Blocked = true
			return nil
		}

		tree, err := Parse(lang, src)
		if err != nil || tree == nil {
			result.Findings = append(result.Findings, Finding{
				Rule:     "scanner",
				Message:  "Failed to parse file: " + errStr(err),
				File:     relPath(dir, path),
				Severity: SeverityError,
			})
			result.Blocked = true
			return nil
		}

		result.FilesScanned++
		root := tree.RootNode()
		rel := relPath(dir, path)

		for _, rule := range s.rules {
			if !ruleApplies(rule, lang) {
				continue
			}
			findings := rule.Check(lang, root, src)
			for i := range findings {
				findings[i].File = rel
				if findings[i].Severity == SeverityError {
					result.Blocked = true
				}
			}
			result.Findings = append(result.Findings, findings...)
		}

		return nil
	})

	if err != nil {
		result.Blocked = true
		result.Error = "Walk error: " + err.Error()
	}

	return result
}

func ruleApplies(rule Rule, lang Language) bool {
	langs := rule.Languages()
	if len(langs) == 0 {
		return true
	}
	for _, l := range langs {
		if l == lang {
			return true
		}
	}
	return false
}

func relPath(base, path string) string {
	rel, err := filepath.Rel(base, path)
	if err != nil {
		return path
	}
	return rel
}

func errStr(err error) string {
	if err == nil {
		return "nil tree"
	}
	return err.Error()
}
