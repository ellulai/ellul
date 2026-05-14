# Post-quantum cryptography (PQC)

Engineering and infrastructure design for ellul.ai's post-quantum migration: hybrid KEMs, ML-DSA signatures, fat-key adjustments, hybrid-DH wallet quantum-blind enforcement, and the migration story across Cloud Run, Cloudflare Workers, R2, and Cloud KMS.

## Section index

| File | Purpose |
| --- | --- |
| `01-engineering-spec.md` | ELLUL-PQC-001: primitive selection, hybrid KEM, signature primitives. |
| `02-cloud-infrastructure.md` | ELLUL-PQC-002: Cloud Run, Workers, R2, KMS PQC config; CI/CD canary + rollback. |
| `03-hybrid-kem.md` | Hybrid KEM construction (X25519 + ML-KEM-768) and protocol integration. |
| `04-ml-dsa-migration.md` | ML-DSA-65 signature migration: keys, manifests, gate signatures. |
| `05-fat-keys.md` | Fat-key length adjustments across the stack. |
| `06-hd-wallet-quantum-blind.md` | Hybrid-DH wallet quantum-blind enforcement. |

These pages are migrated from the legacy `docs/PQC-ENGINEERING-SPEC.md` and `docs/PQC-CLOUD-ARCHITECTURE.md`. See migration ledger for the full mapping.
