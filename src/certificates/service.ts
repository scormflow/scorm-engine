import { randomInt } from 'node:crypto';

import type { PrismaClient } from '../db/client.js';
import type { EventSink } from '../webhooks/events.js';
import { renderCertificatePdf } from './pdf.js';

/**
 * Completion certificates.
 *
 * An attempt earns a certificate once it is completed and has not failed
 * (SCORM 1.2 `passed`/`completed`; SCORM 2004 `completion_status=completed`
 * with `success_status` other than `failed`). The tracking service asks the
 * {@link CertificateIssuer} to issue one whenever an attempt reaches that
 * state; issuing is idempotent, so each attempt gets exactly one.
 */

export class CertificateError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CertificateError';
  }
}

export interface CertificateSettings {
  /** Organization printed as the issuer. */
  issuer: string;
  /**
   * Base URL of the public verification page; the certificate's serial is
   * appended (`<base>/<serial>`) and printed on the PDF. Omit to print none.
   */
  verifyBaseUrl?: string | undefined;
  /** Accent color for the PDF frame and heading, `#rrggbb`. */
  accentColor?: string | undefined;
}

export type CertificateRow = NonNullable<Awaited<ReturnType<PrismaClient['certificate']['findFirst']>>>;
type CertificateWithLearner = CertificateRow & { learner: { externalId: string } | null };

export interface CertificateView {
  id: string;
  serial: string;
  status: 'valid' | 'revoked';
  attemptId: string;
  courseId: string;
  /** The learner's id in the calling system (as passed to `POST /courses/:id/attempts`). */
  learnerId: string | null;
  learnerName: string;
  courseTitle: string;
  scorePercent: number | null;
  completedAt: string;
  issuedAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
  /** Where to download the PDF with an API key. */
  pdfUrl: string;
}

/** What `GET /certificates/verify/:serial` reveals to anyone holding the code. */
export interface CertificateVerification {
  valid: boolean;
  serial: string;
  status: 'valid' | 'revoked';
  learnerName: string;
  courseTitle: string;
  issuer: string;
  completedAt: string;
  issuedAt: string;
  revokedAt: string | null;
}

const LEARNER_SELECT = { learner: { select: { externalId: true } } } as const;

export function serializeCertificate(row: CertificateWithLearner): CertificateView {
  return {
    id: row.id,
    serial: row.serial,
    status: row.revokedAt ? 'revoked' : 'valid',
    attemptId: row.attemptId,
    courseId: row.courseId,
    learnerId: row.learner?.externalId ?? null,
    learnerName: row.learnerName,
    courseTitle: row.courseTitle,
    scorePercent: row.scorePercent ?? null,
    completedAt: row.completedAt.toISOString(),
    issuedAt: row.issuedAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedReason: row.revokedReason ?? null,
    pdfUrl: `/api/v1/certificates/${row.id}/pdf`,
  };
}

/** Crockford base32 minus look-alikes, so codes survive being read aloud or retyped. */
const SERIAL_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A random `XXXX-XXXX-XXXX` code (60 bits). */
export function generateSerial(): string {
  let raw = '';
  for (let i = 0; i < 12; i++) raw += SERIAL_ALPHABET[randomInt(SERIAL_ALPHABET.length)];
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}

/** Normalize user-typed serials: case, spaces, and the I/L/O look-alikes. */
export function normalizeSerial(input: string): string {
  const raw = input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  return raw.length === 12 ? `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}` : input.trim().toUpperCase();
}

/** The attempt columns eligibility and the printed score depend on. */
export interface AttemptOutcome {
  status: string;
  completionStatus: string | null;
  successStatus: string | null;
  scoreRaw: number | null;
  scoreMin: number | null;
  scoreMax: number | null;
  scoreScaled: number | null;
}

/** Completed and not failed. In-progress attempts qualify once content reports completion. */
export function isCertificateEligible(a: Pick<AttemptOutcome, 'completionStatus' | 'successStatus'>): boolean {
  return a.completionStatus === 'COMPLETED' && a.successStatus !== 'FAILED';
}

/** The score as a 0–100 percentage: scaled if reported, else raw within min/max, else null. */
export function scorePercent(a: Pick<AttemptOutcome, 'scoreRaw' | 'scoreMin' | 'scoreMax' | 'scoreScaled'>): number | null {
  if (a.scoreScaled !== null && Number.isFinite(a.scoreScaled)) return clampPercent(a.scoreScaled * 100);
  if (a.scoreRaw === null || !Number.isFinite(a.scoreRaw)) return null;
  const min = a.scoreMin ?? 0;
  const max = a.scoreMax ?? 100;
  if (max <= min) return null;
  return clampPercent(((a.scoreRaw - min) / (max - min)) * 100);
}

function clampPercent(n: number): number {
  return Math.round(Math.min(100, Math.max(0, n)) * 100) / 100;
}

export interface IssueResult {
  certificate: CertificateView;
  /** False when the attempt already had a certificate. */
  created: boolean;
}

/**
 * Issues, reads, revokes and renders certificates for one engine instance.
 * Everything is tenant-scoped by the caller-supplied tenant id.
 */
export class CertificateIssuer {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly settings: CertificateSettings,
    private readonly events?: EventSink | undefined,
    private readonly logger?: { error(obj: object, msg: string): void } | undefined,
  ) {}

  /**
   * The tracking service's hook: issue if eligible, and never throw — a
   * certificate failure is logged, not allowed to fail the learner's commit.
   */
  async issueAfterCommit(tenantId: string, attemptId: string): Promise<void> {
    try {
      await this.issueIfEligible(tenantId, attemptId);
    } catch (err) {
      this.logger?.error({ err, tenantId, attemptId }, 'certificate issue failed');
    }
  }

  /**
   * Issue the attempt's certificate if it is eligible and has none yet.
   * Returns null (without throwing) when the attempt is not eligible, so the
   * tracking service can call it on every qualifying commit.
   */
  async issueIfEligible(tenantId: string, attemptId: string): Promise<IssueResult | null> {
    const attempt = await this.loadAttempt(tenantId, attemptId);
    if (!attempt || !isCertificateEligible(attempt)) return null;
    return this.issue(tenantId, attempt);
  }

  /** Issue on request (`POST /attempts/:id/certificate`); errors if the attempt doesn't qualify. */
  async issueForAttempt(tenantId: string, attemptId: string): Promise<IssueResult> {
    const attempt = await this.loadAttempt(tenantId, attemptId);
    if (!attempt) throw new CertificateError(404, 'attempt_not_found', 'Attempt not found');
    if (!isCertificateEligible(attempt)) {
      throw new CertificateError(
        409,
        'attempt_not_eligible',
        'A certificate needs a completed attempt that has not failed',
      );
    }
    return this.issue(tenantId, attempt);
  }

  async get(tenantId: string, id: string): Promise<CertificateView> {
    return serializeCertificate(await this.find(tenantId, { id }));
  }

  async getForAttempt(tenantId: string, attemptId: string): Promise<CertificateView> {
    return serializeCertificate(await this.find(tenantId, { attemptId }));
  }

  async list(input: {
    tenantId: string;
    learnerId?: string | undefined;
    courseId?: string | undefined;
    status?: string | undefined;
    limit?: number | undefined;
    before?: string | undefined;
  }): Promise<{ data: CertificateView[]; pagination: { nextCursor: string | null; hasMore: boolean } }> {
    if (input.status !== undefined && input.status !== 'valid' && input.status !== 'revoked') {
      throw new CertificateError(400, 'invalid_request', 'status must be "valid" or "revoked"');
    }
    let before: Date | undefined;
    if (input.before) {
      before = new Date(input.before);
      if (Number.isNaN(before.getTime())) {
        throw new CertificateError(400, 'invalid_request', 'before must be an ISO timestamp');
      }
    }
    let learnerRowId: string | undefined;
    if (input.learnerId) {
      const learner = await this.prisma.learner.findUnique({
        where: { tenantId_externalId: { tenantId: input.tenantId, externalId: input.learnerId } },
        select: { id: true },
      });
      if (!learner) return { data: [], pagination: { nextCursor: null, hasMore: false } };
      learnerRowId = learner.id;
    }
    const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
    const rows = await this.prisma.certificate.findMany({
      where: {
        tenantId: input.tenantId,
        ...(learnerRowId ? { learnerId: learnerRowId } : {}),
        ...(input.courseId ? { courseId: input.courseId } : {}),
        ...(input.status === 'valid' ? { revokedAt: null } : {}),
        ...(input.status === 'revoked' ? { revokedAt: { not: null } } : {}),
        ...(before ? { issuedAt: { lt: before } } : {}),
      },
      orderBy: { issuedAt: 'desc' },
      take: limit + 1,
      include: LEARNER_SELECT,
    });
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    return {
      data: page.map(serializeCertificate),
      pagination: { nextCursor: hasMore ? page.at(-1)!.issuedAt.toISOString() : null, hasMore },
    };
  }

  /** Revoke a certificate. Revoking twice keeps the first revocation. */
  async revoke(tenantId: string, id: string, reason?: string | undefined): Promise<CertificateView> {
    const existing = await this.find(tenantId, { id });
    if (existing.revokedAt) return serializeCertificate(existing);
    const updated = await this.prisma.certificate.update({
      where: { id: existing.id },
      data: { revokedAt: new Date(), revokedReason: reason?.trim() || null },
      include: LEARNER_SELECT,
    });
    const view = serializeCertificate(updated);
    this.events?.emit(tenantId, 'certificate.revoked', eventData(view));
    return view;
  }

  /** Public lookup by serial; null when no certificate has that code. */
  async verify(serial: string): Promise<CertificateVerification | null> {
    const row = await this.prisma.certificate.findUnique({ where: { serial: normalizeSerial(serial) } });
    if (!row) return null;
    return {
      valid: !row.revokedAt,
      serial: row.serial,
      status: row.revokedAt ? 'revoked' : 'valid',
      learnerName: row.learnerName,
      courseTitle: row.courseTitle,
      issuer: this.settings.issuer,
      completedAt: row.completedAt.toISOString(),
      issuedAt: row.issuedAt.toISOString(),
      revokedAt: row.revokedAt?.toISOString() ?? null,
    };
  }

  /** Render the certificate PDF; a revoked certificate is stamped as such. */
  async renderPdf(tenantId: string, where: { id: string } | { attemptId: string }): Promise<{ pdf: Buffer; serial: string }> {
    const row = await this.find(tenantId, where);
    const pdf = renderCertificatePdf({
      learnerName: row.learnerName,
      courseTitle: row.courseTitle,
      scorePercent: row.scorePercent ?? null,
      completedAt: row.completedAt,
      issuedAt: row.issuedAt,
      serial: row.serial,
      issuer: this.settings.issuer,
      verifyUrl: this.settings.verifyBaseUrl
        ? `${this.settings.verifyBaseUrl.replace(/\/+$/, '')}/${row.serial}`
        : undefined,
      accentColor: this.settings.accentColor,
      revoked: Boolean(row.revokedAt),
    });
    return { pdf, serial: row.serial };
  }

  // ---- internals -----------------------------------------------------------

  private async find(
    tenantId: string,
    where: { id: string } | { attemptId: string },
  ): Promise<CertificateWithLearner> {
    const row = await this.prisma.certificate.findFirst({
      where: { tenantId, ...where },
      include: LEARNER_SELECT,
    });
    if (!row) throw new CertificateError(404, 'certificate_not_found', 'Certificate not found');
    return row;
  }

  private loadAttempt(tenantId: string, attemptId: string) {
    return this.prisma.attempt.findFirst({
      where: { id: attemptId, tenantId },
      select: {
        id: true,
        courseId: true,
        learnerId: true,
        status: true,
        completionStatus: true,
        successStatus: true,
        scoreRaw: true,
        scoreMin: true,
        scoreMax: true,
        scoreScaled: true,
        lastCommitAt: true,
        finishedAt: true,
        course: { select: { title: true } },
        learner: { select: { externalId: true, name: true } },
      },
    });
  }

  private async issue(
    tenantId: string,
    attempt: NonNullable<Awaited<ReturnType<CertificateIssuer['loadAttempt']>>>,
  ): Promise<IssueResult> {
    const existing = await this.prisma.certificate.findUnique({
      where: { attemptId: attempt.id },
      include: LEARNER_SELECT,
    });
    if (existing) return { certificate: serializeCertificate(existing), created: false };

    const now = new Date();
    const data = {
      tenantId,
      attemptId: attempt.id,
      courseId: attempt.courseId,
      learnerId: attempt.learnerId,
      learnerName: attempt.learner?.name?.trim() || attempt.learner?.externalId || 'Learner',
      courseTitle: attempt.course?.title ?? 'Course',
      scorePercent: scorePercent(attempt),
      completedAt: attempt.finishedAt ?? attempt.lastCommitAt ?? now,
      issuedAt: now,
    };

    // A serial collision (60 bits) or a concurrent issue for the same attempt
    // both surface as a unique violation: re-check the attempt, then retry.
    for (let tries = 0; ; tries++) {
      try {
        const row = await this.prisma.certificate.create({
          data: { ...data, serial: generateSerial() },
          include: LEARNER_SELECT,
        });
        const view = serializeCertificate(row);
        this.events?.emit(tenantId, 'certificate.issued', eventData(view));
        return { certificate: view, created: true };
      } catch (err) {
        if (!isUniqueViolation(err) || tries >= 3) throw err;
        const raced = await this.prisma.certificate.findUnique({
          where: { attemptId: attempt.id },
          include: LEARNER_SELECT,
        });
        if (raced) return { certificate: serializeCertificate(raced), created: false };
      }
    }
  }
}

function eventData(view: CertificateView): Record<string, unknown> {
  return {
    certificateId: view.id,
    serial: view.serial,
    attemptId: view.attemptId,
    courseId: view.courseId,
    learnerId: view.learnerId,
    learnerName: view.learnerName,
    courseTitle: view.courseTitle,
    scorePercent: view.scorePercent,
    completedAt: view.completedAt,
    issuedAt: view.issuedAt,
    revokedAt: view.revokedAt,
    revokedReason: view.revokedReason,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}
