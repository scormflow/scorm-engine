/**
 * PII redaction for AI prompts.
 *
 * The insight context never includes learner ids or names, but free text that
 * flows into it — course titles and descriptions, objective descriptions,
 * learners' typed answers to fill-in interactions, a tenant's own question —
 * can still carry personal data. Before a prompt leaves for a third-party
 * provider it goes through this pass, which swaps recognisable identifiers for
 * placeholders like `[EMAIL]`.
 *
 * It is pattern matching, not understanding: names in prose are not caught.
 * Every pattern is linear-time (bounded or unambiguous quantifiers).
 */

export type PiiKind = 'email' | 'card' | 'ssn' | 'ip' | 'phone';

export interface RedactionResult {
  text: string;
  /** Total replacements. */
  redactions: number;
  counts: Partial<Record<PiiKind, number>>;
}

interface Rule {
  kind: PiiKind;
  pattern: RegExp;
  placeholder: string;
  accept?: (match: string) => boolean;
}

// Order matters: card numbers before phones, so a 16-digit card is one [CARD].
const RULES: Rule[] = [
  {
    kind: 'email',
    pattern: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}/g,
    placeholder: '[EMAIL]',
  },
  {
    kind: 'card',
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    placeholder: '[CARD]',
    accept: (m) => luhn(m.replace(/\D/g, '')),
  },
  { kind: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g, placeholder: '[SSN]' },
  {
    kind: 'ip',
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    placeholder: '[IP]',
    accept: (m) => m.split('.').every((o) => Number(o) <= 255),
  },
  {
    kind: 'phone',
    pattern: /\+?\(?\d[\d ().-]{7,18}\d/g,
    placeholder: '[PHONE]',
    accept: (m) => {
      const digits = m.replace(/\D/g, '').length;
      // Dates and plain decimals are not phone numbers.
      return digits >= 9 && digits <= 15 && !/^\d{4}-\d{2}-\d{2}/.test(m) && !/^\d+\.\d+$/.test(m);
    },
  },
];

export function redactPii(input: string): RedactionResult {
  const counts: Partial<Record<PiiKind, number>> = {};
  let redactions = 0;
  let text = input;
  for (const rule of RULES) {
    text = text.replace(rule.pattern, (match) => {
      if (rule.accept && !rule.accept(match)) return match;
      counts[rule.kind] = (counts[rule.kind] ?? 0) + 1;
      redactions++;
      return rule.placeholder;
    });
  }
  return { text, redactions, counts };
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return digits.length >= 13 && sum % 10 === 0;
}
