; Rule: no-recursive-delete
; Severity: error
; Description: Blocks recursive filesystem deletion functions across all languages.
; Message: ELLUL_SAFETY_ERROR: Recursive deletion is blocked. Remove files individually or request explicit permission from the human user.

; @lang go
(call_expression
  function: (selector_expression
    operand: (identifier) @pkg
    field: (field_identifier) @method)
  (#eq? @pkg "os")
  (#eq? @method "RemoveAll")) @violation

; @lang python
(call
  function: (attribute
    object: (identifier) @pkg
    attribute: (identifier) @method)
  (#eq? @pkg "shutil")
  (#eq? @method "rmtree")) @violation

(call
  function: (attribute
    object: (identifier) @pkg2
    attribute: (identifier) @method2)
  (#eq? @pkg2 "os")
  (#eq? @method2 "removedirs")) @violation

; @lang javascript typescript
(call_expression
  function: (member_expression
    object: (identifier) @pkg
    property: (property_identifier) @method)
  (#eq? @pkg "fs")
  (#match? @method "^(rmSync|rmdirSync)$")) @violation

; @lang rust
(call_expression
  function: (scoped_identifier
    path: (identifier) @pkg
    name: (identifier) @method)
  (#eq? @pkg "fs")
  (#eq? @method "remove_dir_all")) @violation
