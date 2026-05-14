// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

package guardrail

import sitter "github.com/smacker/go-tree-sitter"

// QueryRule adapts a pre-compiled tree-sitter query into the Rule interface.
// Used for dynamic user rules loaded from .scm files.
type QueryRule struct {
	name     string
	langs    []Language
	message  string
	severity Severity
	queries  map[Language]*sitter.Query
}

func (r *QueryRule) Name() string              { return r.name }
func (r *QueryRule) Languages() []Language      { return r.langs }

func (r *QueryRule) Check(lang Language, root *sitter.Node, src []byte) []Finding {
	q, ok := r.queries[lang]
	if !ok {
		return nil
	}

	cursor := sitter.NewQueryCursor()
	cursor.Exec(q, root)

	var findings []Finding
	for {
		match, ok := cursor.NextMatch()
		if !ok {
			break
		}

		for _, capture := range match.Captures {
			captureName := q.CaptureNameForId(capture.Index)
			if captureName != "violation" {
				continue
			}
			node := capture.Node
			findings = append(findings, Finding{
				Rule:     r.name,
				Message:  r.message,
				Line:     int(node.StartPoint().Row) + 1,
				Column:   int(node.StartPoint().Column) + 1,
				Severity: r.severity,
			})
		}
	}

	return findings
}
