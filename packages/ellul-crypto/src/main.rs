// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

//! ellul-crypto: Post-quantum cryptography CLI for Ellul.ai VPS operations.
//!
//! All asymmetric cryptography is post-quantum from day one.
//! No RSA, ECDSA, Ed25519, or X25519 paths exist.
//!
//! Subcommands:
//!   keygen kem     — Generate ML-KEM-1024 keypair
//!   keygen sign    — Generate ML-DSA-65 signing keypair
//!   derive-pub     — Derive public key from private key
//!   decrypt        — ML-KEM-1024 decapsulate + AES-256-GCM decrypt
//!   sign           — Sign data with ML-DSA-65 or SLH-DSA-SHA2-128s
//!   verify         — Verify ML-DSA-65 or SLH-DSA-SHA2-128s signature

mod canonical;
mod decrypt;
mod kem;
mod sign;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "ellul-crypto")]
#[command(about = "Post-quantum cryptography operations for Ellul.ai")]
#[command(version)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Generate a post-quantum keypair
    Keygen {
        #[command(subcommand)]
        kind: KeygenKind,
    },
    /// Derive public key from private key file
    DerivePub {
        /// Path to private key file (JSON)
        #[arg(long)]
        private_in: String,
        /// Path to write public key file (JSON)
        #[arg(long)]
        public_out: String,
    },
    /// Decrypt an ML-KEM-1024 + AES-256-GCM envelope
    Decrypt {
        /// Path to private key file (JSON)
        #[arg(long)]
        key: String,
        /// Read envelope JSON from stdin
        #[arg(long)]
        stdin: bool,
        /// Envelope JSON (alternative to --stdin)
        #[arg(long)]
        envelope: Option<String>,
    },
    /// Sign data with ML-DSA-65 or SLH-DSA-SHA2-128s
    Sign {
        /// Path to private key file (JSON)
        #[arg(long)]
        key: String,
        /// Path to input file to sign
        #[arg(long)]
        input: String,
        /// Algorithm: mldsa65 or slhdsa128s
        #[arg(long)]
        algorithm: String,
    },
    /// Verify a post-quantum signature
    Verify {
        /// Path to public key file (JSON)
        #[arg(long)]
        key: String,
        /// Path to signed data file
        #[arg(long)]
        input: Option<String>,
        /// Path to manifest file (alternative: extracts data + sig from manifest)
        #[arg(long)]
        manifest: Option<String>,
        /// Algorithm: mldsa65 or slhdsa128s
        #[arg(long)]
        algorithm: String,
    },
}

#[derive(Subcommand)]
enum KeygenKind {
    /// Generate ML-KEM-1024 keypair (for E2EE command channel)
    Kem {
        /// Path to write private key (JSON)
        #[arg(long)]
        private_out: String,
        /// Path to write public key (JSON)
        #[arg(long)]
        public_out: String,
    },
    /// Generate ML-DSA signing keypair (ML-DSA-65 default, ML-DSA-44 for heartbeat)
    Sign {
        /// Path to write private key (JSON)
        #[arg(long)]
        private_out: String,
        /// Path to write public key (JSON)
        #[arg(long)]
        public_out: String,
        /// Algorithm: mldsa44 or mldsa65 (default: mldsa65)
        #[arg(long)]
        algorithm: Option<String>,
    },
}

fn main() {
    let cli = Cli::parse();

    let result = match cli.command {
        Commands::Keygen { kind } => match kind {
            KeygenKind::Kem { private_out, public_out } => {
                kem::generate_keypair(&private_out, &public_out)
            }
            KeygenKind::Sign { private_out, public_out, algorithm } => {
                sign::generate_keypair(&private_out, &public_out, algorithm.as_deref())
            }
        },
        Commands::DerivePub { private_in, public_out } => {
            kem::derive_public_key(&private_in, &public_out)
        }
        Commands::Decrypt { key, stdin, envelope } => {
            decrypt::decrypt_envelope(&key, stdin, envelope.as_deref())
        }
        Commands::Sign { key, input, algorithm } => {
            sign::sign_data(&key, &input, &algorithm)
        }
        Commands::Verify { key, input, manifest, algorithm } => {
            sign::verify_data(&key, input.as_deref(), manifest.as_deref(), &algorithm)
        }
    };

    if let Err(e) = result {
        eprintln!("Error: {e}");
        std::process::exit(1);
    }
}
