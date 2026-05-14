// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

package rules

import (
	"testing"

	"github.com/ellul.ai/warden/internal/guardrail"
)

func TestNoDBDrop(t *testing.T) {
	rule := &NoDBDrop{}

	tests := []struct {
		name     string
		lang     guardrail.Language
		src      string
		wantHits int
	}{
		// Go
		{
			name:     "go_drop_table",
			lang:     guardrail.LangGo,
			src:      `package main; import "database/sql"; func f(db *sql.DB) { db.Exec("DROP TABLE users") }`,
			wantHits: 1,
		},
		{
			name:     "go_drop_database",
			lang:     guardrail.LangGo,
			src:      `package main; func f() { q := "DROP DATABASE prod" }`,
			wantHits: 1,
		},
		{
			name:     "go_remove_all",
			lang:     guardrail.LangGo,
			src:      `package main; import "os"; func f() { os.RemoveAll("/tmp") }`,
			wantHits: 1,
		},
		{
			name:     "go_safe",
			lang:     guardrail.LangGo,
			src:      `package main; import "fmt"; func main() { fmt.Println("hello") }`,
			wantHits: 0,
		},
		{
			name:     "go_select_safe",
			lang:     guardrail.LangGo,
			src:      `package main; func f() { q := "SELECT * FROM users" }`,
			wantHits: 0,
		},
		// Python
		{
			name:     "python_drop_table",
			lang:     guardrail.LangPython,
			src:      `conn.execute("DROP TABLE users")`,
			wantHits: 1,
		},
		{
			name:     "python_shutil_rmtree",
			lang:     guardrail.LangPython,
			src:      `import shutil; shutil.rmtree("/tmp")`,
			wantHits: 1,
		},
		{
			name:     "python_safe",
			lang:     guardrail.LangPython,
			src:      `print("hello world")`,
			wantHits: 0,
		},
		// JavaScript
		{
			name:     "js_drop_table",
			lang:     guardrail.LangJavaScript,
			src:      "db.exec('DROP TABLE users');",
			wantHits: 1,
		},
		{
			name:     "js_template_drop",
			lang:     guardrail.LangJavaScript,
			src:      "const q = `DROP TABLE ${table}`;",
			wantHits: 1,
		},
		{
			name:     "js_fs_rmsync",
			lang:     guardrail.LangJavaScript,
			src:      `const fs = require('fs'); fs.rmSync('/tmp', {recursive: true});`,
			wantHits: 1,
		},
		{
			name:     "js_safe",
			lang:     guardrail.LangJavaScript,
			src:      `console.log("hello");`,
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
					t.Logf("  finding: %s at line %d", f.Message, f.Line)
				}
			}

			// Verify all findings are SeverityError
			for _, f := range findings {
				if f.Severity != guardrail.SeverityError {
					t.Errorf("finding %q has severity %d, want SeverityError", f.Rule, f.Severity)
				}
			}
		})
	}
}
