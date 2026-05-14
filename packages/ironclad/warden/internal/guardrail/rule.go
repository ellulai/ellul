// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

package guardrail

import sitter "github.com/smacker/go-tree-sitter"

// Severity determines whether a finding blocks execution.
type Severity int

const (
	// SeverityError blocks execution. The finding is returned to the agent.
	SeverityError Severity = iota
	// SeverityWarning is logged but does not block execution.
	SeverityWarning
)

// Finding represents a single rule violation detected in source code.
type Finding struct {
	Rule     string   `json:"rule"`     // Rule identifier (e.g., "no_db_drop", "user:go_no_panic")
	Message  string   `json:"message"`  // Golden prompt: precise error + exact fix instruction
	File     string   `json:"file"`     // Relative path within workspace
	Line     int      `json:"line"`     // 1-indexed line number
	Column   int      `json:"column"`   // 1-indexed column number
	Severity Severity `json:"severity"` // 0 = error (block), 1 = warning (log)
}

// Language identifies a source language for rule applicability.
type Language string

const (
	LangGo         Language = "go"
	LangPython     Language = "python"
	LangJavaScript Language = "javascript"
	LangTypeScript Language = "typescript"
	LangRust       Language = "rust"
	LangUnknown    Language = "unknown"
)

// Rule is the interface all guardrail rules must implement.
//
// Rules are stateless pure functions: (language, AST, source) -> []Finding.
// They receive a pre-parsed tree-sitter root node and the raw source bytes.
// Source bytes are needed to extract actual string content from node byte ranges.
type Rule interface {
	// Name returns the unique identifier for this rule.
	Name() string

	// Languages returns which languages this rule applies to.
	// An empty slice means the rule applies to all languages.
	Languages() []Language

	// Check inspects a tree-sitter CST with source bytes and returns findings.
	// The scanner fills Finding.File after this returns.
	Check(lang Language, root *sitter.Node, src []byte) []Finding
}
