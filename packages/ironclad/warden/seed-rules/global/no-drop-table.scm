; Rule: no-drop-table
; Severity: error
; Description: Blocks SQL DROP TABLE statements in string literals across all languages.
; Message: ELLUL_SAFETY_ERROR: SQL string contains "DROP TABLE". This operation is blocked. If you need to drop a table, request the db_migrate gate via ellul_gate_request and use a migration framework.

; @lang go
(interpreted_string_literal) @violation
(#match? @violation "[Dd][Rr][Oo][Pp]\\s+[Tt][Aa][Bb][Ll][Ee]")

; @lang python
(string) @violation
(#match? @violation "[Dd][Rr][Oo][Pp]\\s+[Tt][Aa][Bb][Ll][Ee]")

; @lang javascript typescript
(string
  (string_fragment) @violation
  (#match? @violation "[Dd][Rr][Oo][Pp]\\s+[Tt][Aa][Bb][Ll][Ee]"))

; @lang rust
(string_literal) @violation
(#match? @violation "[Dd][Rr][Oo][Pp]\\s+[Tt][Aa][Bb][Ll][Ee]")
