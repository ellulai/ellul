// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

package rules

import (
	"strings"

	sitter "github.com/smacker/go-tree-sitter"

	"github.com/ellul.ai/warden/internal/guardrail"
)

// NoDBDrop detects destructive SQL (DROP TABLE/DATABASE) in string literals
// and destructive filesystem operations (os.RemoveAll, shutil.rmtree, etc.)
// across all supported languages.
type NoDBDrop struct{}

func (r *NoDBDrop) Name() string                    { return "no_db_drop" }
func (r *NoDBDrop) Languages() []guardrail.Language { return nil }

// stringNodeTypes contains tree-sitter node types that represent string literals
// across all supported languages.
var stringNodeTypes = map[string]bool{
	// Go
	"interpreted_string_literal": true,
	"raw_string_literal":         true,
	// Python
	"string":              true,
	"concatenated_string": true,
	// JS/TS
	"template_string": true,
	// Rust
	"string_literal": true,
}

// destructiveCalls maps language to set of blocked "package.function" call patterns.
var destructiveCalls = map[guardrail.Language]map[string]bool{
	guardrail.LangGo:         {"os.RemoveAll": true},
	guardrail.LangPython:     {"shutil.rmtree": true, "os.removedirs": true},
	guardrail.LangJavaScript: {"fs.rmSync": true, "fs.rmdirSync": true},
	guardrail.LangTypeScript: {"fs.rmSync": true, "fs.rmdirSync": true},
	guardrail.LangRust:       {"fs::remove_dir_all": true},
}

func (r *NoDBDrop) Check(lang guardrail.Language, root *sitter.Node, src []byte) []guardrail.Finding {
	var findings []guardrail.Finding

	guardrail.WalkNode(root, func(node *sitter.Node) {
		nodeType := node.Type()

		// Pattern 1: SQL DROP in string literals
		if stringNodeTypes[nodeType] {
			content := string(src[node.StartByte():node.EndByte()])
			upper := strings.ToUpper(content)
			if strings.Contains(upper, "DROP TABLE") || strings.Contains(upper, "DROP DATABASE") {
				findings = append(findings, guardrail.Finding{
					Rule: r.Name(),
					Message: "ELLUL_SAFETY_ERROR: SQL string contains destructive operation " +
						"(DROP TABLE/DATABASE). This operation is blocked. If you need to " +
						"drop a table, request the db_migrate gate via ellul_gate_request " +
						"and use a migration framework.",
					Line:     int(node.StartPoint().Row) + 1,
					Column:   int(node.StartPoint().Column) + 1,
					Severity: guardrail.SeverityError,
				})
			}
		}

		// Pattern 2: Destructive filesystem calls
		if nodeType == "call_expression" || nodeType == "call" {
			callName := extractCallName(node, src)
			if blocked, ok := destructiveCalls[lang]; ok && blocked[callName] {
				findings = append(findings, guardrail.Finding{
					Rule: r.Name(),
					Message: "ELLUL_SAFETY_ERROR: Call to " + callName +
						" detected. Recursive deletion is blocked. Remove files " +
						"individually or request explicit permission from the human user.",
					Line:     int(node.StartPoint().Row) + 1,
					Column:   int(node.StartPoint().Column) + 1,
					Severity: guardrail.SeverityError,
				})
			}
		}
	})

	return findings
}

// extractCallName extracts "package.function" from a call expression node.
// Works across Go (selector_expression), Python (attribute), JS/TS (member_expression).
func extractCallName(node *sitter.Node, src []byte) string {
	fn := node.ChildByFieldName("function")
	if fn == nil {
		return ""
	}
	return string(src[fn.StartByte():fn.EndByte()])
}
