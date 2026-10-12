/**
 * A dependency-free PDF writer for completion certificates.
 *
 * The page is one landscape A4 sheet drawn with the PDF standard-14 Helvetica
 * family, so nothing has to be embedded and every viewer renders it the same.
 * Text is encoded as WinAnsi (Latin-1 plus a few typographic marks); anything
 * outside that set prints as `?`. Output is deterministic for a given input —
 * the same certificate always renders to the same bytes.
 */

export interface CertificatePdfInput {
  learnerName: string;
  courseTitle: string;
  /** 0–100, printed as a whole percentage; omitted when null. */
  scorePercent: number | null;
  completedAt: Date;
  issuedAt: Date;
  serial: string;
  /** Organization named as the issuer. */
  issuer: string;
  /** Public URL a reader can check the certificate at, printed in the footer. */
  verifyUrl?: string | undefined;
  /** Accent color as `#rrggbb`. */
  accentColor?: string | undefined;
  /** Printed when the certificate has been revoked. */
  revoked?: boolean | undefined;
}

type FontName = 'F1' | 'F2' | 'F3';

const PAGE_WIDTH = 842;
const PAGE_HEIGHT = 595;
const DEFAULT_ACCENT = '#1f4e79';

/** Advance widths (1/1000 em) for WinAnsi 32–126: Helvetica (also Helvetica-Oblique). */
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833,
  722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556,
  556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334,
  260, 334, 584,
];

/** Advance widths (1/1000 em) for WinAnsi 32–126: Helvetica-Bold. */
const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833,
  722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611,
  556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389,
  280, 389, 584,
];

/** WinAnsi code points above Latin-1's 0x7F–0x9F gap that differ from Unicode. */
const WIN_ANSI_EXTRAS: Record<number, number> = {
  0x20ac: 0x80, // €
  0x2026: 0x85, // …
  0x2018: 0x91, // ‘
  0x2019: 0x92, // ’
  0x201c: 0x93, // “
  0x201d: 0x94, // ”
  0x2022: 0x95, // •
  0x2013: 0x96, // –
  0x2014: 0x97, // —
};

/** Map a string to WinAnsi bytes (one char per byte, as a latin1 string). */
export function toWinAnsi(text: string): string {
  let out = '';
  for (const ch of text.normalize('NFC')) {
    const cp = ch.codePointAt(0)!;
    if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) out += ch;
    else if (WIN_ANSI_EXTRAS[cp] !== undefined) out += String.fromCharCode(WIN_ANSI_EXTRAS[cp]!);
    else if (cp === 0x09 || cp === 0x0a || cp === 0x0d) out += ' ';
    else out += '?';
  }
  return out;
}

/** Width in points of WinAnsi-encoded `text` set in `font` at `size`. */
export function textWidth(text: string, font: FontName, size: number): number {
  const table = font === 'F2' ? HELVETICA_BOLD : HELVETICA;
  let units = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // Accented Latin-1 letters are close enough to the average lowercase advance.
    units += code >= 32 && code <= 126 ? table[code - 32]! : 556;
  }
  return (units * size) / 1000;
}

/** Escape a WinAnsi string for a PDF literal string. */
function pdfString(text: string): string {
  let out = '(';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const code = text.charCodeAt(i);
    if (ch === '(' || ch === ')' || ch === '\\') out += `\\${ch}`;
    else if (code > 126) out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += ch;
  }
  return `${out})`;
}

/** `#rrggbb` → PDF `r g b` operands in 0–1. */
function rgb(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex) ?? /^#?(..)(..)(..)$/.exec(DEFAULT_ACCENT)!;
  return [m[1], m[2], m[3]].map((h) => (parseInt(h!, 16) / 255).toFixed(3)).join(' ');
}

/** Fit `text` into `maxWidth`: shrink down to `minSize`, then truncate with an ellipsis. */
function fit(text: string, font: FontName, size: number, minSize: number, maxWidth: number): { text: string; size: number } {
  let s = size;
  while (s > minSize && textWidth(text, font, s) > maxWidth) s -= 1;
  if (textWidth(text, font, s) <= maxWidth) return { text, size: s };
  const ellipsis = '\x85';
  let cut = text;
  while (cut.length > 1 && textWidth(cut + ellipsis, font, s) > maxWidth) cut = cut.slice(0, -1);
  return { text: cut.trimEnd() + ellipsis, size: s };
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** "12 October 2026", in UTC so the output doesn't depend on the server's zone. */
export function formatCertificateDate(date: Date): string {
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** `D:YYYYMMDDHHmmSSZ` for the document info dictionary. */
function pdfDate(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `D:${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
}

/** Render a certificate as a complete PDF file. */
export function renderCertificatePdf(input: CertificatePdfInput): Buffer {
  const accent = rgb(input.accentColor ?? DEFAULT_ACCENT);
  const ops: string[] = [];
  const cx = PAGE_WIDTH / 2;
  const maxTextWidth = PAGE_WIDTH - 160;

  type Align = 'center' | 'left' | 'right';
  /** Draw `raw`, shrunk (then truncated) to fit `maxWidth` if it would overflow. */
  const text = (
    raw: string,
    font: FontName,
    size: number,
    y: number,
    align: Align,
    x = cx,
    opts: { minSize?: number; maxWidth?: number } = {},
  ) => {
    const f = fit(toWinAnsi(raw), font, size, opts.minSize ?? size, opts.maxWidth ?? maxTextWidth);
    const w = textWidth(f.text, font, f.size);
    const tx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    ops.push(`BT /${font} ${f.size} Tf ${tx.toFixed(2)} ${y.toFixed(2)} Td ${pdfString(f.text)} Tj ET`);
  };

  // Frame: a heavy accent border with a hairline inside it.
  ops.push(`${accent} RG 4 w 24 24 ${PAGE_WIDTH - 48} ${PAGE_HEIGHT - 48} re S`);
  ops.push(`0.75 w 36 36 ${PAGE_WIDTH - 72} ${PAGE_HEIGHT - 72} re S`);

  ops.push(`${accent} rg`);
  text('CERTIFICATE OF COMPLETION', 'F2', 30, 468, 'center');
  ops.push('0.25 0.25 0.25 rg');
  text('This certifies that', 'F3', 15, 420, 'center');
  ops.push('0 0 0 rg');
  text(input.learnerName, 'F2', 34, 368, 'center', cx, { minSize: 16 });
  ops.push(`${accent} RG 1 w ${cx - 200} 356 m ${cx + 200} 356 l S`);
  ops.push('0.25 0.25 0.25 rg');
  text('has successfully completed', 'F3', 15, 318, 'center');
  ops.push('0 0 0 rg');
  text(input.courseTitle, 'F2', 24, 276, 'center', cx, { minSize: 12 });

  const details = [`Completed on ${formatCertificateDate(input.completedAt)}`];
  if (input.scorePercent !== null && Number.isFinite(input.scorePercent)) {
    details.unshift(`Score: ${Math.round(input.scorePercent)}%`);
  }
  ops.push('0.25 0.25 0.25 rg');
  text(details.join('   •   '), 'F1', 13, 232, 'center');

  // Footer: issuer on the left, serial (and where to verify it) on the right.
  ops.push(`${accent} RG 0.75 w 80 130 m 300 130 l S`);
  ops.push('0 0 0 rg');
  text(input.issuer, 'F2', 13, 112, 'left', 80, { minSize: 9, maxWidth: 220 });
  ops.push('0.35 0.35 0.35 rg');
  text(`Issued ${formatCertificateDate(input.issuedAt)}`, 'F1', 10, 96, 'left', 80);
  text(`Certificate ID: ${input.serial}`, 'F1', 10, 112, 'right', PAGE_WIDTH - 80);
  if (input.verifyUrl) {
    text(`Verify at ${input.verifyUrl}`, 'F1', 9, 96, 'right', PAGE_WIDTH - 80, { minSize: 6, maxWidth: 360 });
  }

  if (input.revoked) {
    ops.push('0.75 0.1 0.1 rg');
    text('REVOKED', 'F2', 48, 160, 'center');
  }

  const content = ops.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      '/Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>',
    `<< /Title ${pdfString(toWinAnsi(`Certificate ${input.serial}`))} /Author ${pdfString(toWinAnsi(input.issuer))} ` +
      `/Subject ${pdfString(toWinAnsi(input.courseTitle))} /Producer (ScormFlow) /CreationDate (${pdfDate(input.issuedAt)}) >>`,
  ];

  let body = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
