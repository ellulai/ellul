// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

package guardrail

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	sitter "github.com/smacker/go-tree-sitter"
)

// queryMeta holds metadata parsed from .scm file header comments.
type queryMeta struct {
	name     string
	severity Severity
	message  string
}

// langSection is a language-specific query body parsed from a multi-language .scm file.
type langSection struct {
	languages []Language
	queryBody string
}

// LoadUserRules reads .scm files from dir, compiles each into a QueryRule.
//
// Supports two file formats:
//
//  1. Single-language: <language>_<name>.scm (e.g., go_no-panic.scm)
//     The entire file body is the query for that one language.
//
//  2. Multi-language: <name>.scm (e.g., no-drop-table.scm)
//     Contains "; @lang <lang> [<lang>...]" markers that split the file
//     into per-language query sections. One file, one concept, all languages.
//
// Returns empty slice if dir doesn't exist (silent proceed).
// Returns error on any malformed query (fail-closed).
func LoadUserRules(dir string) ([]Rule, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read user rules dir: %w", err)
	}

	var rules []Rule
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".scm") {
			continue
		}

		src, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			return nil, fmt.Errorf("read rule %s: %w", entry.Name(), err)
		}

		meta := parseQueryMeta(src)
		ruleName := strings.TrimSuffix(entry.Name(), ".scm")

		// Detect format: if filename contains underscore AND the prefix is a known
		// language, it's single-language. Otherwise it's multi-language with @lang sections.
		var rule Rule
		var loadErr error

		parts := strings.SplitN(ruleName, "_", 2)
		if len(parts) == 2 {
			if _, isLang := langRegistry[Language(parts[0])]; isLang {
				// Single-language format: go_no-panic.scm
				rule, loadErr = loadSingleLangRule(entry.Name(), parts[0], parts[1], src, meta)
			} else {
				// Filename has underscore but prefix isn't a language — treat as multi-lang
				rule, loadErr = loadMultiLangRule(entry.Name(), ruleName, src, meta)
			}
		} else {
			// No underscore — must be multi-language format: no-drop-table.scm
			rule, loadErr = loadMultiLangRule(entry.Name(), ruleName, src, meta)
		}

		if loadErr != nil {
			return nil, loadErr
		}
		if rule != nil {
			rules = append(rules, rule)
		}
	}

	return rules, nil
}

// loadSingleLangRule handles the <language>_<name>.scm format.
func loadSingleLangRule(filename, langStr, ruleName string, src []byte, meta queryMeta) (Rule, error) {
	lang := Language(langStr)
	if _, ok := langRegistry[lang]; !ok {
		return nil, fmt.Errorf(
			"unknown language %q in rule %s — supported: go, python, javascript, typescript, rust",
			langStr, filename,
		)
	}

	queryStr := stripQueryComments(src)
	if queryStr == "" {
		return nil, fmt.Errorf("empty query body in %s", filename)
	}

	if meta.message == "" {
		meta.message = fmt.Sprintf("Rule '%s' matched", ruleName)
	}

	grammar := langRegistry[lang]
	q, qErr := sitter.NewQuery([]byte(queryStr), grammar)
	if qErr != nil {
		return nil, fmt.Errorf(
			"compile query %s for language %s: %w — check S-expression syntax and node type names",
			filename, lang, qErr,
		)
	}

	return &QueryRule{
		name:     ruleName,
		langs:    []Language{lang},
		message:  meta.message,
		severity: meta.severity,
		queries:  map[Language]*sitter.Query{lang: q},
	}, nil
}

// loadMultiLangRule handles the <name>.scm format with "; @lang" sections.
//
// File format:
//
//	; Rule: no-drop-table
//	; Message: SQL DROP TABLE is blocked...
//
//	; @lang go
//	(interpreted_string_literal) @violation
//	(#match? @violation "DROP TABLE")
//
//	; @lang python
//	(string) @violation
//	(#match? @violation "DROP TABLE")
//
//	; @lang javascript typescript
//	(string (string_fragment) @violation ...)
func loadMultiLangRule(filename, ruleName string, src []byte, meta queryMeta) (Rule, error) {
	sections := parseLangSections(src)
	if len(sections) == 0 {
		return nil, fmt.Errorf(
			"no '; @lang' sections found in multi-language rule %s — "+
				"either use <language>_<name>.scm format for single-language rules, "+
				"or add '; @lang go' / '; @lang python' sections",
			filename,
		)
	}

	if meta.message == "" {
		meta.message = fmt.Sprintf("Rule '%s' matched", ruleName)
	}

	compiled := make(map[Language]*sitter.Query)
	var allLangs []Language

	for _, section := range sections {
		for _, lang := range section.languages {
			grammar, ok := langRegistry[lang]
			if !ok {
				return nil, fmt.Errorf(
					"unknown language %q in @lang section of %s — supported: go, python, javascript, typescript, rust",
					lang, filename,
				)
			}

			q, qErr := sitter.NewQuery([]byte(section.queryBody), grammar)
			if qErr != nil {
				return nil, fmt.Errorf(
					"compile query %s for language %s: %w — check S-expression syntax and node type names",
					filename, lang, qErr,
				)
			}

			compiled[lang] = q
			allLangs = append(allLangs, lang)
		}
	}

	return &QueryRule{
		name:     ruleName,
		langs:    allLangs,
		message:  meta.message,
		severity: meta.severity,
		queries:  compiled,
	}, nil
}

// parseLangSections splits a multi-language .scm file into per-language query bodies.
// Sections are delimited by "; @lang <language> [<language>...]" comment lines.
// Lines before the first @lang marker are ignored (they're header comments).
func parseLangSections(src []byte) []langSection {
	var sections []langSection
	var currentLangs []Language
	var currentLines []string

	scanner := bufio.NewScanner(bytes.NewReader(src))
	for scanner.Scan() {
		line := scanner.Text()
		trimmed := strings.TrimSpace(line)

		// Check for @lang marker
		if strings.HasPrefix(trimmed, "; @lang ") {
			// Flush previous section
			if len(currentLangs) > 0 {
				body := strings.TrimSpace(strings.Join(currentLines, "\n"))
				if body != "" {
					sections = append(sections, langSection{
						languages: currentLangs,
						queryBody: body,
					})
				}
			}

			// Parse language(s) from the marker: "; @lang go" or "; @lang javascript typescript"
			langPart := strings.TrimSpace(trimmed[len("; @lang "):])
			currentLangs = nil
			for _, l := range strings.Fields(langPart) {
				currentLangs = append(currentLangs, Language(l))
			}
			currentLines = nil
			continue
		}

		// Skip comment lines within a section (but not the query body)
		if len(currentLangs) > 0 {
			// Inside a @lang section — collect non-empty, non-comment lines as query body
			if trimmed != "" && !strings.HasPrefix(trimmed, ";") {
				currentLines = append(currentLines, line)
			}
		}
	}

	// Flush final section
	if len(currentLangs) > 0 {
		body := strings.TrimSpace(strings.Join(currentLines, "\n"))
		if body != "" {
			sections = append(sections, langSection{
				languages: currentLangs,
				queryBody: body,
			})
		}
	}

	return sections
}

// parseQueryMeta extracts ; Rule:, ; Severity:, ; Message:, ; Description: from header comments.
func parseQueryMeta(src []byte) queryMeta {
	meta := queryMeta{severity: SeverityError}
	scanner := bufio.NewScanner(bytes.NewReader(src))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, ";") {
			continue
		}
		// Stop parsing metadata at @lang marker
		if strings.HasPrefix(line, "; @lang ") {
			break
		}
		content := strings.TrimSpace(line[1:])
		if strings.HasPrefix(content, "Rule:") {
			meta.name = strings.TrimSpace(content[5:])
		} else if strings.HasPrefix(content, "Severity:") {
			s := strings.TrimSpace(strings.ToLower(content[9:]))
			if s == "warning" {
				meta.severity = SeverityWarning
			}
		} else if strings.HasPrefix(content, "Message:") {
			meta.message = strings.TrimSpace(content[8:])
		}
	}
	return meta
}

// stripQueryComments removes comment lines from the query source,
// leaving only the S-expression query body. Used for single-language files.
func stripQueryComments(src []byte) string {
	var lines []string
	scanner := bufio.NewScanner(bytes.NewReader(src))
	for scanner.Scan() {
		line := scanner.Text()
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, ";") {
			continue
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}
