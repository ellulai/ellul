/**
 * PQC Health Check — verifies ML-KEM round-trip works.
 * Run: npx tsx packages/pqc-types/src/health-check.ts
 */
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';

const kp = ml_kem1024.keygen();
console.log('ML-KEM-1024 keygen:', kp.publicKey.length, 'B pk,', kp.secretKey.length, 'B sk');

const { cipherText, sharedSecret: ss1 } = ml_kem1024.encapsulate(kp.publicKey);
console.log('ML-KEM-1024 encapsulate:', cipherText.length, 'B ct,', ss1.length, 'B ss');

const ss2 = ml_kem1024.decapsulate(cipherText, kp.secretKey);
const match = Buffer.from(ss1).equals(Buffer.from(ss2));
console.log('ML-KEM-1024 round-trip:', match ? 'PASS' : 'FAIL');

if (!match) {
  console.error('CRITICAL: ML-KEM round-trip FAILED');
  process.exit(1);
}

console.log('\nPQC health check PASSED');
