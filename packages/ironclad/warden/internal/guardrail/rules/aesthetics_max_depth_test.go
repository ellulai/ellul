// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

package rules

import (
	"testing"

	"github.com/ellul.ai/warden/internal/guardrail"
)

func TestAestheticsMaxDepth(t *testing.T) {
	rule := &AestheticsMaxDepth{Threshold: 2}

	tests := []struct {
		name     string
		lang     guardrail.Language
		src      string
		wantHits int
	}{
		// Go — allowed
		{
			name:     "go_depth_1_ok",
			lang:     guardrail.LangGo,
			src:      `package main; func f() { result := foo(x) }`,
			wantHits: 0,
		},
		{
			name:     "go_depth_2_ok",
			lang:     guardrail.LangGo,
			src:      `package main; func f() { result := foo(bar(x)) }`,
			wantHits: 0,
		},
		// Go — blocked
		{
			name:     "go_depth_3_blocked",
			lang:     guardrail.LangGo,
			src:      `package main; func f() { result := foo(bar(baz(x))) }`,
			wantHits: 1,
		},
		{
			name:     "go_call_index_call_blocked",
			lang:     guardrail.LangGo,
			src:      `package main; func f() { result := foo(arr[getIndex()]) }`,
			wantHits: 1,
		},
		// Python — allowed
		{
			name:     "python_depth_1_ok",
			lang:     guardrail.LangPython,
			src:      `result = foo(x)`,
			wantHits: 0,
		},
		{
			name:     "python_depth_2_ok",
			lang:     guardrail.LangPython,
			src:      `result = data[get_key()]`,
			wantHits: 0,
		},
		// Python — blocked
		{
			name:     "python_depth_3_blocked",
			lang:     guardrail.LangPython,
			src:      `result = foo(bar(baz(x)))`,
			wantHits: 1,
		},
		{
			name:     "python_nested_subscript_blocked",
			lang:     guardrail.LangPython,
			src:      `result = process(data[get_key()])`,
			wantHits: 1,
		},
		// JavaScript — allowed
		{
			name:     "js_depth_1_ok",
			lang:     guardrail.LangJavaScript,
			src:      `const x = foo(y);`,
			wantHits: 0,
		},
		// JavaScript — blocked
		{
			name:     "js_depth_3_blocked",
			lang:     guardrail.LangJavaScript,
			src:      `const x = foo(bar(baz(y)));`,
			wantHits: 1,
		},
		{
			name:     "js_call_subscript_call_blocked",
			lang:     guardrail.LangJavaScript,
			src:      `const x = foo(bar(arr[idx]));`,
			wantHits: 1,
		},
		// No findings for simple assignment
		{
			name:     "go_simple_assignment",
			lang:     guardrail.LangGo,
			src:      `package main; func f() { x := 42 }`,
			wantHits: 0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tree, err := guardrail.Parse(tt.lang, []byte(tt.src))
			if err != nil {
				t.Fatalf("parse error: %v", err)
			}

			findings := rule.Check(tt.lang, tree.RootNode(), []byte(tt.src))
			if len(findings) != tt.wantHits {
				t.Errorf("got %d findings, want %d", len(findings), tt.wantHits)
				for _, f := range findings {
					t.Logf("  finding: %s", f.Message)
				}
			}

			for _, f := range findings {
				if f.Severity != guardrail.SeverityError {
					t.Errorf("finding %q has severity %d, want SeverityError", f.Rule, f.Severity)
				}
			}
		})
	}
}
