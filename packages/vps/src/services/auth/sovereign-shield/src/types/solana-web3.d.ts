/**
 * Minimal type declarations for @solana/web3.js
 *
 * The full package is installed globally on the VPS (marked external in esbuild).
 * These declarations allow TypeScript compilation without the package being local.
 */
declare module '@solana/web3.js' {
  export class PublicKey {
    constructor(value: string | Uint8Array);
    toBase58(): string;
    toBuffer(): Buffer;
    equals(other: PublicKey): boolean;
    static isOnCurve(pubkey: Uint8Array): boolean;
  }

  export class Keypair {
    constructor();
    static generate(): Keypair;
    static fromSecretKey(secretKey: Uint8Array): Keypair;
    static fromSeed(seed: Uint8Array): Keypair;
    readonly publicKey: PublicKey;
    readonly secretKey: Uint8Array;
  }

  export class Transaction {
    recentBlockhash: string;
    feePayer: PublicKey;
    add(...instructions: TransactionInstruction[]): Transaction;
    sign(...signers: Keypair[]): void;
    serialize(): Buffer;
  }

  export class TransactionInstruction {
    constructor(opts: {
      keys: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }>;
      programId: PublicKey;
      data: Buffer;
    });
  }

  export class SystemProgram {
    static transfer(params: {
      fromPubkey: PublicKey;
      toPubkey: PublicKey;
      lamports: number;
    }): TransactionInstruction;
  }
}
