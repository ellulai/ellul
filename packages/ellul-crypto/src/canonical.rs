// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

//! Canonical JSON serialization — sorted keys, compact output.
//!
//! Matches TypeScript `canonicalJson()` and Bash `jq -cS '.'` exactly.
//!
//! This is defensive: even if serde_json's `preserve_order` feature is ever
//! enabled by a transitive dependency, this function will still sort keys
//! explicitly. The Rust and TypeScript canonical serializers together define
//! the signing contract — `jq` is a convenience check, not the authority.

use serde_json::Value;

/// Produce canonical JSON: recursively sorted keys, no whitespace.
///
/// Cannot fail for any well-formed `serde_json::Value`.
pub fn canonical_json(value: &Value) -> String {
    let mut buf = String::new();
    write_canonical(value, &mut buf);
    buf
}

fn write_canonical(value: &Value, buf: &mut String) {
    match value {
        Value::Null => buf.push_str("null"),
        Value::Bool(b) => buf.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => buf.push_str(&n.to_string()),
        Value::String(s) => {
            // Delegate string escaping to serde_json — handles \n, \t, \u, \\, \"
            // identically to JavaScript's JSON.stringify.
            buf.push_str(&serde_json::to_string(s).unwrap());
        }
        Value::Array(arr) => {
            buf.push('[');
            for (i, item) in arr.iter().enumerate() {
                if i > 0 {
                    buf.push(',');
                }
                write_canonical(item, buf);
            }
            buf.push(']');
        }
        Value::Object(map) => {
            // Collect and sort keys explicitly — the core defensive guarantee.
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            buf.push('{');
            for (i, key) in keys.iter().enumerate() {
                if i > 0 {
                    buf.push(',');
                }
                buf.push_str(&serde_json::to_string(*key).unwrap());
                buf.push(':');
                write_canonical(&map[*key], buf);
            }
            buf.push('}');
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sorted_keys() {
        let val = json!({"z": 1, "a": 2, "m": 3});
        assert_eq!(canonical_json(&val), r#"{"a":2,"m":3,"z":1}"#);
    }

    #[test]
    fn nested_sorted_keys() {
        let val = json!({"b": {"z": 1, "a": 2}, "a": 3});
        assert_eq!(canonical_json(&val), r#"{"a":3,"b":{"a":2,"z":1}}"#);
    }

    #[test]
    fn array_order_preserved() {
        let val = json!({"arr": [3, 1, 2]});
        assert_eq!(canonical_json(&val), r#"{"arr":[3,1,2]}"#);
    }

    #[test]
    fn array_of_objects_sorted() {
        let val = json!({"items": [{"z": 1, "a": 2}, {"b": 3, "a": 4}]});
        assert_eq!(
            canonical_json(&val),
            r#"{"items":[{"a":2,"z":1},{"a":4,"b":3}]}"#
        );
    }

    #[test]
    fn empty_containers() {
        assert_eq!(canonical_json(&json!({})), "{}");
        assert_eq!(canonical_json(&json!([])), "[]");
    }

    #[test]
    fn null_boolean_string() {
        let val = json!({"b": true, "a": null, "c": "hello"});
        assert_eq!(canonical_json(&val), r#"{"a":null,"b":true,"c":"hello"}"#);
    }

    #[test]
    fn string_escaping() {
        let val = json!({"key": "line1\nline2\ttab\"quote"});
        assert_eq!(
            canonical_json(&val),
            r#"{"key":"line1\nline2\ttab\"quote"}"#
        );
    }

    #[test]
    fn unicode_non_ascii() {
        // Non-ASCII printable characters pass through as UTF-8 (no \u escaping)
        // matching JavaScript JSON.stringify behavior
        let val = json!({"cafe": "café", "emoji": "🔑"});
        assert_eq!(
            canonical_json(&val),
            r#"{"cafe":"café","emoji":"🔑"}"#
        );
    }

    #[test]
    fn unicode_control_chars() {
        // Control characters (U+0000 to U+001F) are escaped as \uXXXX
        // matching JavaScript JSON.stringify behavior
        let val = json!({"ctrl": "\u{0000}\u{001f}"});
        let result = canonical_json(&val);
        assert_eq!(result, r#"{"ctrl":"\u0000\u001f"}"#);
    }

    #[test]
    fn integers_no_trailing_zero() {
        let val = json!({"sector": 512, "size": 67108864});
        assert_eq!(
            canonical_json(&val),
            r#"{"sector":512,"size":67108864}"#
        );
    }

    #[test]
    fn backslash_in_string() {
        let val = json!({"path": "C:\\Users\\test"});
        assert_eq!(
            canonical_json(&val),
            r#"{"path":"C:\\Users\\test"}"#
        );
    }

    #[test]
    fn deeply_nested() {
        let val = json!({"c": {"b": {"a": 1}}});
        assert_eq!(canonical_json(&val), r#"{"c":{"b":{"a":1}}}"#);
    }

    /// Cross-language fixture: this exact output must match TypeScript
    /// canonicalJson() for the same input. This is the primary gate.
    #[test]
    fn manifest_cross_language_fixture() {
        let val = json!({
            "version": 1,
            "serverId": "srv_abc123",
            "chunks": [
                {"index": 0, "sha256": "deadbeef", "sizeBytes": 67108864},
                {"index": 1, "sha256": "cafebabe", "sizeBytes": 67108864}
            ],
            "volumeLayout": {
                "luksHeaderHash": "aabbccdd",
                "sectorSize": 512,
                "physicalSectorSize": 512,
                "luksVersion": 2,
                "luksPayloadOffset": 0
            },
            "volumeSizeBytes": 134217728,
            "targetServerId": null,
            "signedBy": "vps-migration-key"
        });

        let result = canonical_json(&val);

        // No whitespace anywhere
        assert!(!result.contains(' '), "must have no whitespace");

        // Top-level keys must be alphabetically sorted
        let chunk_pos = result.find("\"chunks\"").unwrap();
        let server_pos = result.find("\"serverId\"").unwrap();
        let signed_pos = result.find("\"signedBy\"").unwrap();
        let target_pos = result.find("\"targetServerId\"").unwrap();
        let version_pos = result.find("\"version\"").unwrap();
        let vol_layout_pos = result.find("\"volumeLayout\"").unwrap();
        let vol_size_pos = result.find("\"volumeSizeBytes\"").unwrap();
        assert!(chunk_pos < server_pos);
        assert!(server_pos < signed_pos);
        assert!(signed_pos < target_pos);
        assert!(target_pos < version_pos);
        assert!(version_pos < vol_layout_pos);
        assert!(vol_layout_pos < vol_size_pos);

        // Nested volumeLayout keys must be sorted
        let luks_header_pos = result.find("\"luksHeaderHash\"").unwrap();
        let luks_offset_pos = result.find("\"luksPayloadOffset\"").unwrap();
        let luks_version_pos = result.find("\"luksVersion\"").unwrap();
        let phys_sector_pos = result.find("\"physicalSectorSize\"").unwrap();
        let sector_pos = result.find("\"sectorSize\"").unwrap();
        assert!(luks_header_pos < luks_offset_pos);
        assert!(luks_offset_pos < luks_version_pos);
        assert!(luks_version_pos < phys_sector_pos);
        assert!(phys_sector_pos < sector_pos);

        // Chunk objects must have sorted keys
        let first_chunk = r#"{"index":0,"sha256":"deadbeef","sizeBytes":67108864}"#;
        assert!(result.contains(first_chunk), "chunk object keys must be sorted");

        // null renders as null
        assert!(result.contains("\"targetServerId\":null"));
    }
}
