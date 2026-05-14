#!/bin/bash
# SPDX-License-Identifier: BUSL-1.1
# Copyright (c) 2026 ellul.ai. All rights reserved.
#
# Unit tests for perf-monitor.sh PSI extraction. Plain bash, exit 0/1.

set -euo pipefail

cd "$(dirname "$0")"

PERF_SCRIPT="perf-monitor.sh"
if [ ! -f "$PERF_SCRIPT" ]; then
  echo "FAIL: $PERF_SCRIPT not found in $(pwd)"
  exit 1
fi

# Sourcing the whole script would launch the `while true` monitor loop,
# so we extract just the function under test.
extract_function() {
  local fn="$1"
  awk -v fn="$fn" '
    $0 ~ "^"fn"\\(\\) \\{" { in_fn = 1; print; next }
    in_fn && /^}/           { print; in_fn = 0; next }
    in_fn                   { print }
  ' "$PERF_SCRIPT"
}

FN_SRC=$(extract_function read_psi_full_avg60)
if [ -z "$FN_SRC" ]; then
  echo "FAIL: could not extract read_psi_full_avg60 from $PERF_SCRIPT"
  exit 1
fi

TMP=$(mktemp)
trap "rm -f $TMP" EXIT

# Rewrite /proc path → temp file we control.
TESTABLE_FN=$(echo "$FN_SRC" | sed "s|/proc/pressure/memory|$TMP|g")

eval "$TESTABLE_FN"

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; exit 1; }

# ── Test 1: real-world PSI sample, full avg60 = 23.18 → rounds to 23 ──
cat > "$TMP" <<EOF
some avg10=21.99 avg60=30.89 avg300=26.11 total=140436654
full avg10=20.28 avg60=23.18 avg300=23.64 total=127021504
EOF
got=$(read_psi_full_avg60)
[ "$got" = "23" ] || fail "real-world: expected 23, got '$got'"
pass "real-world PSI sample → full avg60=23"

# ── Test 2: regression — must NOT pick up the "some" line ──
cat > "$TMP" <<EOF
some avg10=21.99 avg60=30.89 avg300=26.11 total=140436654
full avg10=20.28 avg60=23.18 avg300=23.64 total=127021504
EOF
got=$(read_psi_full_avg60)
[ "$got" != "22" ] || fail "regression: function read 'some' line — saw 22, the avg10 of some"
[ "$got" != "31" ] || fail "regression: function read avg60 of 'some' — saw 31, the avg60 of some"
pass "does not regress to reading 'some' line (got $got, want 23)"

# ── Test 3: high pressure clears the 60% threshold ──
cat > "$TMP" <<EOF
some avg10=85.55 avg60=92.00 avg300=80.00 total=999
full avg10=70.00 avg60=75.55 avg300=72.00 total=999
EOF
got=$(read_psi_full_avg60)
[ "$got" = "76" ] || fail "high-pressure rounding: expected 76, got '$got'"
pass "high pressure full avg60=75.55 → 76"

# ── Test 4: degenerate input (missing /full line) → 0 ──
cat > "$TMP" <<EOF
some avg10=10 avg60=10 avg300=10 total=0
EOF
got=$(read_psi_full_avg60)
[ "$got" = "0" ] || fail "missing-full: expected 0, got '$got'"
pass "missing /full line → 0"

# ── Test 5: empty file → 0 ──
: > "$TMP"
got=$(read_psi_full_avg60)
[ "$got" = "0" ] || fail "empty-file: expected 0, got '$got'"
pass "empty PSI file → 0"

# ── Test 6: whitespace variation (tabs, double spaces) ──
cat > "$TMP" <<EOF
some  avg10=1.00  avg60=1.00  avg300=1.00  total=0
full	avg10=4.00	avg60=42.00	avg300=4.00	total=0
EOF
got=$(read_psi_full_avg60)
[ "$got" = "42" ] || fail "tabs+double-spaces: expected 42, got '$got'"
pass "tab-separated fields → 42"

echo "all PSI extraction tests passed"
