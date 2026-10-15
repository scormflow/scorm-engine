import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { KeyVault, KeyVaultError, keyHint, parseMasterKey } from '../../src/ai/index.js';

describe('KeyVault', () => {
  const vault = new KeyVault(randomBytes(32));

  it('round-trips a key and never stores the plaintext', () => {
    const sealed = vault.seal('tenant_a', 'sk-live-abcdef123456');
    expect(sealed.ciphertext).toMatch(/^v1\./);
    expect(sealed.wrappedKey).toMatch(/^v1\./);
    expect(JSON.stringify(sealed)).not.toContain('abcdef123456');
    expect(vault.open('tenant_a', sealed)).toBe('sk-live-abcdef123456');
  });

  it('uses a fresh data key each time', () => {
    const a = vault.seal('tenant_a', 'same');
    const b = vault.seal('tenant_a', 'same');
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.wrappedKey).not.toBe(b.wrappedKey);
  });

  it('refuses to open another tenant’s row', () => {
    const sealed = vault.seal('tenant_a', 'secret');
    expect(() => vault.open('tenant_b', sealed)).toThrow(KeyVaultError);
  });

  it('refuses a different master key or a tampered row', () => {
    const sealed = vault.seal('tenant_a', 'secret');
    expect(() => new KeyVault(randomBytes(32)).open('tenant_a', sealed)).toThrow(KeyVaultError);
    const [v, iv, tag, ct] = sealed.ciphertext.split('.');
    const flipped = `${v}.${iv}.${tag}.${ct!.slice(0, -2)}AA`;
    expect(() => vault.open('tenant_a', { ...sealed, ciphertext: flipped })).toThrow(KeyVaultError);
  });
});

describe('parseMasterKey', () => {
  it('accepts hex and base64 of 32 bytes', () => {
    const raw = randomBytes(32);
    expect(parseMasterKey(raw.toString('hex')).equals(raw)).toBe(true);
    expect(parseMasterKey(raw.toString('base64')).equals(raw)).toBe(true);
  });

  it('rejects other lengths', () => {
    expect(() => parseMasterKey('abcd')).toThrow(KeyVaultError);
    expect(() => parseMasterKey(randomBytes(16).toString('hex'))).toThrow(KeyVaultError);
  });
});

describe('keyHint', () => {
  it('shows only the last four characters of a real key', () => {
    expect(keyHint('sk-ant-api03-xyz9876')).toBe('…9876');
    expect(keyHint('short')).toBe('…');
  });
});
