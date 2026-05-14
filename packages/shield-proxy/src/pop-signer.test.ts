// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { describe, it, expect } from 'vitest';
import * as crypto from 'crypto';
import { signRequest } from './pop-signer';
import type { PopHmacKey } from './pop-signer';

/** Generate a random HMAC key for testing (simulates ML-KEM bind output) */
function makeTestHmacKey(): PopHmacKey {
  return { hmacKeyBase64: crypto.randomBytes(32).toString('base64') };
}

describe('PoP Signer (HMAC-SHA256)', () => {
  describe('signRequest with Buffer body', () => {
    it('hashes binary body identically to crypto.createHash', () => {
      const key = makeTestHmacKey();
      const binaryBody = Buffer.from([0x1f, 0x8b, 0x00, 0xff, 0xfe]);
      const headers = signRequest(key, 'POST', '/_auth/exec/sync', binaryBody);

      // Reconstruct payload with the same binary hash
      const bodyHash = crypto.createHash('sha256').update(binaryBody).digest('base64');
      const payload = `${headers['X-PoP-Timestamp']}|POST|/_auth/exec/sync|${bodyHash}|${headers['X-PoP-Nonce']}`;

      // Verify HMAC
      const expected = crypto.createHmac('sha256', Buffer.from(key.hmacKeyBase64, 'base64'))
        .update(payload)
        .digest('base64');
      expect(headers['X-PoP-Signature']).toBe(expected);
    });

    it('string body and Buffer body with same content produce same hash', () => {
      const text = '{"key":"value"}';
      const textBuf = Buffer.from(text);

      const hashStr = crypto.createHash('sha256').update(text).digest('base64');
      const hashBuf = crypto.createHash('sha256').update(textBuf).digest('base64');
      expect(hashStr).toBe(hashBuf);
    });

    it('empty Buffer produces empty bodyHash (same as null)', () => {
      const key = makeTestHmacKey();
      const headersNull = signRequest(key, 'GET', '/test', null);
      const headersEmpty = signRequest(key, 'GET', '/test', Buffer.alloc(0));

      // Both should produce verifiable HMAC signatures with empty body hash
      for (const headers of [headersNull, headersEmpty]) {
        const payload = `${headers['X-PoP-Timestamp']}|GET|/test||${headers['X-PoP-Nonce']}`;
        const expected = crypto.createHmac('sha256', Buffer.from(key.hmacKeyBase64, 'base64'))
          .update(payload)
          .digest('base64');
        expect(headers['X-PoP-Signature']).toBe(expected);
      }
    });

    it('different binary bodies produce different signatures', () => {
      const key = makeTestHmacKey();
      const body1 = Buffer.from([0x01, 0x02, 0x03]);
      const body2 = Buffer.from([0x04, 0x05, 0x06]);

      const h1 = signRequest(key, 'POST', '/test', body1);
      const h2 = signRequest(key, 'POST', '/test', body2);

      expect(h1['X-PoP-Signature']).not.toBe(h2['X-PoP-Signature']);
    });

    it('different keys produce different signatures for same payload', () => {
      const key1 = makeTestHmacKey();
      const key2 = makeTestHmacKey();
      const body = '{"action":"test"}';

      const h1 = signRequest(key1, 'POST', '/test', body);
      const h2 = signRequest(key2, 'POST', '/test', body);

      expect(h1['X-PoP-Signature']).not.toBe(h2['X-PoP-Signature']);
    });
  });
});
