// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

package guardrail

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"

	sitter "github.com/smacker/go-tree-sitter"
	"github.com/smacker/go-tree-sitter/golang"
	"github.com/smacker/go-tree-sitter/javascript"
	"github.com/smacker/go-tree-sitter/python"
	"github.com/smacker/go-tree-sitter/rust"
	tsTypescript "github.com/smacker/go-tree-sitter/typescript/typescript"
)

// langRegistry maps Language to its tree-sitter grammar.
// Grammars are vendored as C code inside the Go module.
var langRegistry = map[Language]*sitter.Language{
	LangGo:         golang.GetLanguage(),
	LangPython:     python.GetLanguage(),
	LangJavaScript: javascript.GetLanguage(),
	LangTypeScript: tsTypescript.GetLanguage(),
	LangRust:       rust.GetLanguage(),
}

// LangRegistry returns the language registry for use by the query loader.
func LangRegistry() map[Language]*sitter.Language {
	return langRegistry
}

// extToLang maps file extensions to languages.
var extToLang = map[string]Language{
	".go":  LangGo,
	".py":  LangPython,
	".js":  LangJavaScript,
	".jsx": LangJavaScript,
	".ts":  LangTypeScript,
	".tsx": LangTypeScript,
	".mjs": LangJavaScript,
	".cjs": LangJavaScript,
	".mts": LangTypeScript,
	".cts": LangTypeScript,
	".rs":  LangRust,
}

// DetectLanguage returns the Language for a file path based on its extension.
func DetectLanguage(path string) Language {
	ext := strings.ToLower(filepath.Ext(path))
	if lang, ok := extToLang[ext]; ok {
		return lang
	}
	return LangUnknown
}

// Parse parses source bytes with the appropriate tree-sitter grammar.
//
// Tree-sitter is error-tolerant: syntax errors produce ERROR nodes in the tree,
// not a nil return. A nil tree only occurs on fundamental failures (e.g., wrong
// grammar pointer). This means rules can still run on partially-valid files.
func Parse(lang Language, src []byte) (*sitter.Tree, error) {
	grammar, ok := langRegistry[lang]
	if !ok {
		return nil, fmt.Errorf("unsupported language: %s", lang)
	}
	parser := sitter.NewParser()
	parser.SetLanguage(grammar)
	tree, err := parser.ParseCtx(context.Background(), nil, src)
	if err != nil {
		return nil, err
	}
	return tree, nil
}

// WalkNode recursively visits every node in the tree, calling fn on each.
func WalkNode(node *sitter.Node, fn func(*sitter.Node)) {
	fn(node)
	for i := 0; i < int(node.ChildCount()); i++ {
		WalkNode(node.Child(i), fn)
	}
}
