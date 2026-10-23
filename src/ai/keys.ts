import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for tenants' AI provider keys.
 *
 * The operator supplies one master key (`AI_MASTER_KEY`). Each tenant gets its
 * own key-encryption key derived from it with HKDF, and each stored provider
 * key is encrypted under a fresh random data key that is itself wrapped by the
 * tenant's key. Both layers are AES-256-GCM with the tenant id as additional
 * data, so a ciphertext copied into another tenant's row does not decrypt.
 *
 * Rotating the master key means re-sealing every stored key; there is no
 * built-in rotation yet.
 */

export interface SealedSecret {
  /** The provider key under the data key: `v1.<iv>.<tag>.<ciphertext>` (base64url). */
  ciphertext: string;
  /** The data key under the tenant key, same format. */
  wrappedKey: string;
}

export class KeyVaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyVaultError';
  }
}

const VERSION = 'v1';
const HKDF_SALT = Buffer.from('scormflow-ai-keys');

/** Parse `AI_MASTER_KEY`: 64 hex characters or base64 of exactly 32 bytes. */
export function parseMasterKey(raw: string): Buffer {
  const value = raw.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (key.length !== 32) {
    throw new KeyVaultError('AI_MASTER_KEY must be 32 bytes, as 64 hex characters or base64');
  }
  return key;
}

export class KeyVault {
  private readonly master: Buffer;

  constructor(masterKey: Buffer) {
    if (masterKey.length !== 32) throw new KeyVaultError('master key must be 32 bytes');
    this.master = Buffer.from(masterKey);
  }

  seal(tenantId: string, plaintext: string): SealedSecret {
    const dataKey = randomBytes(32);
    const aad = Buffer.from(tenantId);
    return {
      ciphertext: encrypt(dataKey, Buffer.from(plaintext, 'utf8'), aad),
      wrappedKey: encrypt(this.tenantKey(tenantId), dataKey, aad),
    };
  }

  open(tenantId: string, sealed: SealedSecret): string {
    const aad = Buffer.from(tenantId);
    try {
      const dataKey = decrypt(this.tenantKey(tenantId), sealed.wrappedKey, aad);
      return decrypt(dataKey, sealed.ciphertext, aad).toString('utf8');
    } catch {
      throw new KeyVaultError('stored key cannot be decrypted (wrong AI_MASTER_KEY or tampered row)');
    }
  }

  private tenantKey(tenantId: string): Buffer {
    return Buffer.from(hkdfSync('sha256', this.master, HKDF_SALT, `tenant:${tenantId}`, 32));
  }
}

function encrypt(key: Buffer, plaintext: Buffer, aad: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), ct].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

function decrypt(key: Buffer, sealed: string, aad: Buffer): Buffer {
  const [version, iv, tag, ct] = sealed.split('.');
  if (version !== VERSION || !iv || !tag || ct === undefined) throw new KeyVaultError('malformed ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]);
}

/** What the API shows instead of a key: its last four characters. */
export function keyHint(key: string): string {
  return key.length > 8 ? `…${key.slice(-4)}` : '…';
}
