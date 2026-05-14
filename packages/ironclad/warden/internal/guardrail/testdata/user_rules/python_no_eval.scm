; Rule: python_no_eval
; Severity: error
; Message: Do not use eval() or exec() — they enable arbitrary code execution. Use ast.literal_eval() for safe parsing, or restructure the code to avoid dynamic evaluation entirely.

(call
  function: (identifier) @fn
  (#match? @fn "^(eval|exec)$")) @violation
