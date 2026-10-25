import { describe, expect, it } from 'vitest';

import { redactPii } from '../../src/ai/index.js';

describe('redactPii', () => {
  it('replaces emails, cards, SSNs, IPs and phone numbers', () => {
    const input = [
      'Contact grace.hopper+news@navy.example.mil about it.',
      'Card 4111 1111 1111 1111 on file.',
      'SSN 123-45-6789.',
      'Logged in from 192.168.10.24.',
      'Call +1 (555) 123-4567 or 020 7946 0958.',
    ].join(' ');
    const out = redactPii(input);
    expect(out.text).toBe(
      'Contact [EMAIL] about it. Card [CARD] on file. SSN [SSN]. Logged in from [IP]. Call [PHONE] or [PHONE].',
    );
    expect(out.counts).toEqual({ email: 1, card: 1, ssn: 1, ip: 1, phone: 2 });
    expect(out.redactions).toBe(6);
  });

  it('leaves the numbers an analytics context is made of alone', () => {
    const input = JSON.stringify({
      from: '2026-10-01T09:30:00.000Z',
      to: '2026-10-15T17:05:12.345Z',
      completionRate: 0.5714,
      averageScore: 0.8123,
      attempts: 500,
      version: '2004 4th edition',
      location: 'slide-08',
    });
    const out = redactPii(input);
    expect(out.text).toBe(input);
    expect(out.redactions).toBe(0);
  });

  it('does not mistake a non-Luhn 16-digit number for a card', () => {
    expect(redactPii('order 1234 5678 9012 3456').counts.card).toBeUndefined();
  });

  it('rejects out-of-range IPv4 octets', () => {
    expect(redactPii('version 1.2.300.4').counts.ip).toBeUndefined();
  });

  it('stays fast on adversarial input', () => {
    const started = Date.now();
    redactPii(`${'a'.repeat(50_000)}@`);
    redactPii('1 '.repeat(50_000));
    redactPii(`${'1.'.repeat(30_000)}x`);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
