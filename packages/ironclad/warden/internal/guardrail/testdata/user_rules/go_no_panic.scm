; Rule: go_no_panic
; Severity: error
; Message: Do not use panic() — return an error instead. Panics crash the entire process and bypass recovery middleware. Use fmt.Errorf() and return the error to the caller.

(call_expression
  function: (identifier) @fn
  (#eq? @fn "panic")) @violation
