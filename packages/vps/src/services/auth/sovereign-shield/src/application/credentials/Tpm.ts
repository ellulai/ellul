// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * TPM Service
 *
 * Hardware attestation via TPM 2.0 (feature-flagged).
 * Shells out to tpm2-tools CLI — same pattern as netns.service.ts using spawn.
 *
 * Graceful degradation: all functions return null if TPM unavailable.
 */

import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { TPM_FEATURE_FILE, TPM_CERT_DIR } from '../../config';

// ── Feature Flag ──

let tpmAvailable: boolean | null = null;
let featureCheckTime = 0;
const FEATURE_CACHE_MS = 30_000;

export function isTPMAvailable(): boolean {
  const now = Date.now();
  if (tpmAvailable !== null && now - featureCheckTime < FEATURE_CACHE_MS) {
    return tpmAvailable;
  }

  featureCheckTime = now;

  // Check feature flag file
  if (!fs.existsSync(TPM_FEATURE_FILE)) {
    tpmAvailable = false;
    return false;
  }

  // Check TPM device
  try {
    execFileSync('tpm2_pcrread', ['sha256:0'], { timeout: 5000, stdio: 'pipe' });
    tpmAvailable = true;
  } catch {
    tpmAvailable = false;
  }

  return tpmAvailable;
}

// ── PCR Extension ──

export function extendPCR(pcrIndex: number, digest: string): void {
  if (!isTPMAvailable()) return;

  try {
    execFileSync('tpm2_pcrextend', [`${pcrIndex}:sha256=${digest}`], {
      timeout: 5000,
      stdio: 'pipe',
    });
  } catch (err) {
    console.error(`[tpm] Failed to extend PCR[${pcrIndex}]:`, err instanceof Error ? err.message : err);
  }
}

// ── Quote Generation ──

export interface TpmQuote {
  raw_quote: string;     // Base64 TPMS_ATTEST structure
  quote_signature: string; // Base64 AK signature
  signature_algorithm: string;
  pcr_values: {
    hash_algorithm: string;
    pcrs: Record<string, string>;
  };
  nonce_in_quote: string;
}

export function generateQuote(
  nonce: string,
  pcrSelection: number[] = [0, 4, 5, 8, 9, 15],
): TpmQuote | null {
  if (!isTPMAvailable()) return null;

  try {
    const nonceHex = Buffer.from(nonce, 'base64').toString('hex');
    const pcrList = `sha256:${pcrSelection.join(',')}`;

    // Generate quote
    const quotePath = '/tmp/tpm_quote.dat';
    const sigPath = '/tmp/tpm_sig.dat';

    execFileSync('tpm2_quote', [
      '-c', '0x81010001', // AK handle (standard location)
      '-l', pcrList,
      '-q', nonceHex,
      '-o', quotePath,
      '-s', sigPath,
      '-f', 'plain',
    ], { timeout: 10000, stdio: 'pipe' });

    const rawQuote = fs.readFileSync(quotePath).toString('base64');
    const quoteSig = fs.readFileSync(sigPath).toString('base64');

    // Read PCR values
    const pcrOutput = execFileSync('tpm2_pcrread', [pcrList], {
      timeout: 5000,
      encoding: 'utf8',
    });

    const pcrs: Record<string, string> = {};
    for (const line of pcrOutput.split('\n')) {
      const match = line.match(/^\s*(\d+)\s*:\s*0x([0-9a-fA-F]+)/);
      if (match?.[1] && match[2]) {
        pcrs[match[1]] = match[2].toLowerCase();
      }
    }

    // Cleanup
    try { fs.unlinkSync(quotePath); } catch {}
    try { fs.unlinkSync(sigPath); } catch {}

    return {
      raw_quote: rawQuote,
      quote_signature: quoteSig,
      signature_algorithm: 'RSASSA-PSS-SHA256',
      pcr_values: {
        hash_algorithm: 'sha256',
        pcrs,
      },
      nonce_in_quote: nonce,
    };
  } catch (err) {
    console.error('[tpm] Failed to generate quote:', err instanceof Error ? err.message : err);
    return null;
  }
}

// ── Certificate Access ──

export function getAKCertificate(): string | null {
  try {
    return fs.readFileSync(`${TPM_CERT_DIR}/ak-cert.pem`, 'utf8');
  } catch {
    return null;
  }
}

export function getEKCertificate(): string | null {
  try {
    return fs.readFileSync(`${TPM_CERT_DIR}/ek-cert.pem`, 'utf8');
  } catch {
    return null;
  }
}

// ── Boot-Time Measurement ──

export function measureProxyBinary(binaryPath: string): void {
  if (!isTPMAvailable()) return;

  try {
    const binaryContent = fs.readFileSync(binaryPath);
    const digest = crypto.createHash('sha256').update(binaryContent).digest('hex');
    extendPCR(15, digest);
    console.log(`[tpm] Extended PCR[15] with proxy binary hash: ${digest.slice(0, 16)}...`);
  } catch (err) {
    console.error('[tpm] Failed to measure proxy binary:', err instanceof Error ? err.message : err);
  }
}
