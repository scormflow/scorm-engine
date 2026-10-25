import type { PrismaClient } from '../db/client.js';
import { ATTEMPT_COOKIE } from '../auth/attempt-token.js';
import { findSco } from '../tracking/index.js';
import { manifestScos } from '../versioning/service.js';

/** What launch resolution needs to know about an attempt. */
export const LAUNCH_ATTEMPT_SELECT = {
  courseId: true,
  sco: { select: { identifier: true } },
  course: { select: { launchUrl: true, storageKey: true } },
  courseVersion: { select: { launchUrl: true, storageKey: true, manifest: true } },
} as const;

export interface LaunchAttempt {
  courseId: string;
  sco: { identifier: string } | null;
  course: { launchUrl: string; storageKey: string };
  courseVersion: { launchUrl: string; storageKey: string; manifest: unknown } | null;
}

export interface ResolvedLaunch {
  /** Manifest identifier of the SCO being launched, or null for the release's primary entry. */
  scoId: string | null;
  /** Engine-hosted content path, e.g. `/api/v1/courses/<id>/content/index.html`. */
  path: string;
}

/**
 * Resolve the content path an attempt launches.
 *
 * `scoRef` overrides the attempt's own SCO; both are manifest identifiers (a
 * `Sco.id` row id is accepted too). An attempt pinned to a release launches
 * from that release's manifest, not the live one. Returns null when an explicit
 * SCO does not exist; an attempt with no SCO falls back to the primary entry.
 */
export async function resolveLaunch(
  prisma: PrismaClient,
  attempt: LaunchAttempt,
  scoRef?: string,
): Promise<ResolvedLaunch | null> {
  const release = attempt.courseVersion ?? attempt.course;
  const ref = scoRef ?? attempt.sco?.identifier;

  let scoId: string | null = null;
  let launchHref: string | undefined;
  if (ref) {
    const pinned = attempt.courseVersion ? manifestScos(attempt.courseVersion.manifest) : null;
    let match: { identifier: string; launchHref: string } | undefined = pinned?.find((s) => s.identifier === ref);
    if (!match) {
      // Not an identifier in the pinned release — maybe a row id, or a live-only SCO.
      const sco = await findSco(prisma, attempt.courseId, ref);
      match = sco && pinned ? pinned.find((s) => s.identifier === sco.identifier) : sco ?? undefined;
    }
    if (!match) return null;
    scoId = match.identifier;
    launchHref = match.launchHref || undefined;
  }
  // Fall back to the release's primary launch URL (storageKey-relative).
  if (!launchHref) {
    const prefix = `${release.storageKey}/`;
    launchHref = release.launchUrl.startsWith(prefix) ? release.launchUrl.slice(prefix.length) : release.launchUrl;
  }
  return { scoId, path: `/api/v1/courses/${encodeURIComponent(attempt.courseId)}/content/${launchHref}` };
}

/**
 * `Set-Cookie` value carrying an attempt token to the content route, so a SCO's
 * relative sub-resource requests authenticate. Over HTTPS the cookie is
 * `SameSite=None; Partitioned` so it still reaches the engine when the player
 * iframe is embedded in a host page on another site.
 */
export function attemptCookie(token: string, secure: boolean): string {
  const base = `${ATTEMPT_COOKIE}=${encodeURIComponent(token)}; Path=/api/v1/courses; HttpOnly`;
  return secure ? `${base}; Secure; SameSite=None; Partitioned` : `${base}; SameSite=Lax`;
}

/** Whether the client reached us over HTTPS (directly or via a proxy). */
export function isSecureRequest(req: { protocol: string; headers: Record<string, unknown> }): boolean {
  const forwarded = req.headers['x-forwarded-proto'];
  const proto = typeof forwarded === 'string' ? forwarded.split(',')[0]!.trim() : req.protocol;
  return proto === 'https';
}
