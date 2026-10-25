import { describe, expect, it } from 'vitest';

import {
  formatCertificateDate,
  renderCertificatePdf,
  textWidth,
  toWinAnsi,
  type CertificatePdfInput,
} from '../../src/certificates/pdf.js';
import {
  generateSerial,
  isCertificateEligible,
  normalizeSerial,
  scorePercent,
} from '../../src/certificates/service.js';

const INPUT: CertificatePdfInput = {
  learnerName: 'Ada Lovelace',
  courseTitle: 'Safety Basics',
  scorePercent: 92.4,
  completedAt: new Date('2026-10-12T09:30:00Z'),
  issuedAt: new Date('2026-10-12T09:31:00Z'),
  serial: '7KQ2-M9XD-4TPA',
  issuer: 'Acme Academy',
};

/** The page's content stream, as latin1 text. */
function contentStream(pdf: Buffer): string {
  const text = pdf.toString('latin1');
  const m = /stream\n([\s\S]*?)\nendstream/.exec(text);
  expect(m).not.toBeNull();
  return m![1]!;
}

describe('renderCertificatePdf', () => {
  it('writes a structurally valid single-page PDF', () => {
    const pdf = renderCertificatePdf(INPUT);
    const text = pdf.toString('latin1');
    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('/Type /Pages /Kids [3 0 R] /Count 1');
    expect(text).toContain('/BaseFont /Helvetica-Bold');

    // Every xref offset points at the start of its object.
    const startxref = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');
    const entries = text.slice(startxref).split('\n').slice(3, 11);
    entries.forEach((entry, i) => {
      const offset = Number(entry.slice(0, 10));
      expect(text.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
    });

    // The declared stream length matches the stream's bytes.
    const declared = Number(/<< \/Length (\d+) >>/.exec(text)![1]);
    expect(Buffer.byteLength(contentStream(pdf), 'latin1')).toBe(declared);
  });

  it('prints the learner, course, score, dates, issuer and serial', () => {
    const stream = contentStream(renderCertificatePdf({ ...INPUT, verifyUrl: 'https://lms.example/verify/7KQ2-M9XD-4TPA' }));
    expect(stream).toContain('(Ada Lovelace)');
    expect(stream).toContain('(Safety Basics)');
    expect(stream).toContain('Score: 92%');
    expect(stream).toContain('Completed on 12 October 2026');
    expect(stream).toContain('(Acme Academy)');
    expect(stream).toContain('Certificate ID: 7KQ2-M9XD-4TPA');
    expect(stream).toContain('Verify at https://lms.example/verify/7KQ2-M9XD-4TPA');
    expect(stream).not.toContain('REVOKED');
  });

  it('omits the score when there is none and stamps revoked certificates', () => {
    const stream = contentStream(renderCertificatePdf({ ...INPUT, scorePercent: null, revoked: true }));
    expect(stream).not.toContain('Score:');
    expect(stream).toContain('(REVOKED)');
  });

  it('is deterministic', () => {
    expect(renderCertificatePdf(INPUT).equals(renderCertificatePdf(INPUT))).toBe(true);
  });

  it('escapes PDF string delimiters and encodes Latin-1 as octal', () => {
    const stream = contentStream(renderCertificatePdf({ ...INPUT, learnerName: 'José (Pepe) \\ Núñez' }));
    expect(stream).toContain('(Jos\\351 \\(Pepe\\) \\\\ N\\372\\361ez)');
  });

  it('shrinks, then truncates, text that would overflow the page', () => {
    const long = 'Advanced Occupational Health and Safety Management for Hazardous Industrial Environments '.repeat(3);
    const stream = contentStream(renderCertificatePdf({ ...INPUT, courseTitle: long }));
    const line = stream.split('\n').find((l) => l.includes('Advanced Occupational'))!;
    expect(line).toMatch(/\/F2 12 Tf/);
    expect(line).toContain('\\205'); // ellipsis
  });
});

describe('certificate helpers', () => {
  it('maps text to WinAnsi', () => {
    expect(toWinAnsi('Café — “ok”')).toBe('Caf\xe9 \x97 \x93ok\x94');
    expect(toWinAnsi('日本')).toBe('??');
  });

  it('measures Helvetica text', () => {
    expect(textWidth('AAA', 'F1', 10)).toBeCloseTo(20.01);
    expect(textWidth('i', 'F2', 1000)).toBe(278);
  });

  it('formats dates in UTC', () => {
    expect(formatCertificateDate(new Date('2026-01-01T23:30:00-05:00'))).toBe('2 January 2026');
  });

  it('generates and normalizes serials', () => {
    const serial = generateSerial();
    expect(serial).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(normalizeSerial(serial.toLowerCase().replace(/-/g, ' '))).toBe(serial);
    expect(normalizeSerial('7kq2m9xd4tpo')).toBe('7KQ2-M9XD-4TP0');
  });

  it('decides eligibility: completed and not failed', () => {
    expect(isCertificateEligible({ completionStatus: 'COMPLETED', successStatus: 'PASSED' })).toBe(true);
    expect(isCertificateEligible({ completionStatus: 'COMPLETED', successStatus: 'UNKNOWN' })).toBe(true);
    expect(isCertificateEligible({ completionStatus: 'COMPLETED', successStatus: 'FAILED' })).toBe(false);
    expect(isCertificateEligible({ completionStatus: 'INCOMPLETE', successStatus: 'PASSED' })).toBe(false);
  });

  it('computes the printed score', () => {
    const none = { scoreRaw: null, scoreMin: null, scoreMax: null, scoreScaled: null };
    expect(scorePercent(none)).toBeNull();
    expect(scorePercent({ ...none, scoreScaled: 0.875 })).toBe(87.5);
    expect(scorePercent({ ...none, scoreRaw: 18, scoreMin: 0, scoreMax: 20 })).toBe(90);
    expect(scorePercent({ ...none, scoreRaw: 75 })).toBe(75);
    expect(scorePercent({ ...none, scoreRaw: 5, scoreMin: 10, scoreMax: 10 })).toBeNull();
    expect(scorePercent({ ...none, scoreScaled: 1.4 })).toBe(100);
  });
});
