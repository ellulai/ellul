; Rule: no-drop-database
; Severity: error
; Description: Blocks SQL DROP DATABASE statements in string literals across all languages.
; Message: ELLUL_SAFETY_ERROR: SQL string contains "DROP DATABASE". This operation is blocked. If you need to drop a database, request the db_migrate gate via ellul_gate_request.

; @lang go
(interpreted_string_literal) @violation
(#match? @violation "[Dd][Rr][Oo][Pp]\\s+[Dd][Aa][Tt][Aa][Bb][Aa][Ss][Ee]")

; @lang python
(string) @violation
(#match? @violation "[Dd][Rr][Oo][Pp]\\s+[Dd][Aa][Tt][Aa][Bb][Aa][Ss][Ee]")

; @lang javascript typescript
(string
  (string_fragment) @violation
  (#match? @violation "[Dd][Rr][Oo][Pp]\\s+[Dd][Aa][Tt][Aa][Bb][Aa][Ss][Ee]"))

; @lang rust
(string_literal) @violation
(#match? @violation "[Dd][Rr][Oo][Pp]\\s+[Dd][Aa][Tt][Aa][Bb][Aa][Ss][Ee]")
