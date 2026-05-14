// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

package rules

import (
	"fmt"
	"strings"

	sitter "github.com/smacker/go-tree-sitter"

	"github.com/ellul.ai/warden/internal/guardrail"
)

// AestheticsMaxDepth enforces a maximum nesting depth for "action" nodes
// (calls, indexing, type assertions) within a single statement.
// 100% deterministic geometric calculation of AST graph depth.
type AestheticsMaxDepth struct {
	Threshold int // Maximum allowed depth (default: 2)
}

func (r *AestheticsMaxDepth) Name() string                    { return "aesthetics_max_depth" }
func (r *AestheticsMaxDepth) Languages() []guardrail.Language { return nil }

// statementNodes contains tree-sitter node types that represent statement boundaries.
// Each statement is measured independently.
var statementNodes = map[string]bool{
	// Go
	"expression_statement":  true,
	"short_var_declaration": true,
	"assignment_statement":  true,
	"return_statement":      true,
	// Python
	"assignment":           true,
	"augmented_assignment": true,
	// JS/TS
	"variable_declaration": true,
	"lexical_declaration":  true,
	// "expression_statement" and "return_statement" shared across Go/Python/JS
}

// depthNodes maps language to the set of node types that increment nesting depth.
var depthNodes = map[guardrail.Language]map[string]bool{
	guardrail.LangGo: {
		"call_expression":  true,
		"index_expression": true,
		"slice_expression": true,
		"type_assertion":   true,
	},
	guardrail.LangPython: {
		"call":      true,
		"subscript": true,
	},
	guardrail.LangJavaScript: {
		"call_expression":      true,
		"subscript_expression": true,
		"new_expression":       true,
	},
	guardrail.LangTypeScript: {
		"call_expression":      true,
		"subscript_expression": true,
		"new_expression":       true,
	},
	guardrail.LangRust: {
		"call_expression":  true,
		"index_expression": true,
	},
}

func (r *AestheticsMaxDepth) Check(lang guardrail.Language, root *sitter.Node, src []byte) []guardrail.Finding {
	threshold := r.Threshold
	if threshold <= 0 {
		threshold = 2
	}

	actionNodes, ok := depthNodes[lang]
	if !ok {
		return nil
	}

	var findings []guardrail.Finding

	guardrail.WalkNode(root, func(node *sitter.Node) {
		if !statementNodes[node.Type()] {
			return
		}

		maxDepth := computeMaxDepth(node, actionNodes, 0)
		if maxDepth > threshold {
			snippet := extractSnippet(node, src, 80)
			findings = append(findings, guardrail.Finding{
				Rule: r.Name(),
				Message: fmt.Sprintf(
					"ELLUL_AESTHETIC_ERROR: Max depth %d exceeded (depth %d) at line %d, col %d.\n"+
						"The nested call/index chain %q must be decomposed.\n"+
						"FIX: Extract the innermost expression into a named intermediate variable, "+
						"then pass that variable to the outer call. One action per line.",
					threshold, maxDepth, node.StartPoint().Row+1, node.StartPoint().Column+1, snippet),
				Line:     int(node.StartPoint().Row) + 1,
				Column:   int(node.StartPoint().Column) + 1,
				Severity: guardrail.SeverityError,
			})
		}
	})

	return findings
}

// computeMaxDepth recursively calculates the maximum nesting depth of
// action nodes within a subtree. Pure function, no side effects.
func computeMaxDepth(node *sitter.Node, actionNodes map[string]bool, currentDepth int) int {
	myDepth := currentDepth
	if actionNodes[node.Type()] {
		myDepth = currentDepth + 1
	}
	maxChild := myDepth
	for i := 0; i < int(node.ChildCount()); i++ {
		childMax := computeMaxDepth(node.Child(i), actionNodes, myDepth)
		if childMax > maxChild {
			maxChild = childMax
		}
	}
	return maxChild
}

// extractSnippet extracts a source snippet from a node, truncated to maxLen.
func extractSnippet(node *sitter.Node, src []byte, maxLen int) string {
	content := strings.TrimSpace(string(src[node.StartByte():node.EndByte()]))
	if len(content) > maxLen {
		content = content[:maxLen] + "..."
	}
	return content
}
