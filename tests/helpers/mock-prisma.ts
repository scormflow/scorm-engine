import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '../../src/db/client.js';
import { hashApiKey } from '../../src/auth/api-key.js';

interface CourseRow {
  id: string;
  tenantId: string;
  title: string;
  description: string | null;
  scormVersion: string;
  storageKey: string;
  launchUrl: string;
  masteryScore: number | null;
  manifest: unknown;
  createdAt: Date;
  updatedAt: Date;
  scos: Array<{
    id: string;
    courseId: string;
    identifier: string;
    title: string;
    launchHref: string;
    parameters: string | null;
    order: number;
  }>;
}

interface ApiKeyRow {
  id: string;
  tenantId: string;
  hashedKey: string;
  revokedAt: Date | null;
}

export interface MockPrismaSeed {
  apiKeyPlaintext?: string;
  tenantId?: string;
}

export interface MockPrismaResult {
  prisma: PrismaClient;
  state: {
    courses: CourseRow[];
    versions: any[];
    apiKeys: ApiKeyRow[];
    tenantId: string;
    apiKeyPlaintext: string;
  };
}

/**
 * Build a tiny in-memory stand-in for PrismaClient covering the operations the
 * courses route uses today. We avoid pulling in real Prisma so route tests can
 * run without spinning up Postgres.
 */
export function createMockPrisma(seed: MockPrismaSeed = {}): MockPrismaResult {
  const tenantId = seed.tenantId ?? 'tenant_test';
  const apiKeyPlaintext = seed.apiKeyPlaintext ?? 'sk_test_abcdef';
  const apiKey: ApiKeyRow = {
    id: 'apikey_test',
    tenantId,
    hashedKey: hashApiKey(apiKeyPlaintext),
    revokedAt: null,
  };

  const courses: CourseRow[] = [];
  const apiKeys: ApiKeyRow[] = [apiKey];
  const versions: any[] = [];

  const prisma: PrismaClient = {
    apiKey: {
      findUnique: async ({ where, select: _select }: { where: { hashedKey: string }; select?: unknown }) => {
        const row = apiKeys.find((k) => k.hashedKey === where.hashedKey);
        return row ? { id: row.id, tenantId: row.tenantId, revokedAt: row.revokedAt } : null;
      },
    },
    course: {
      create: async ({ data }: { data: any }) => {
        const now = new Date();
        const row: CourseRow = {
          id: data.id ?? randomUUID(),
          tenantId: data.tenantId,
          title: data.title,
          description: data.description ?? null,
          scormVersion: data.scormVersion,
          storageKey: data.storageKey,
          launchUrl: data.launchUrl,
          masteryScore: data.masteryScore ?? null,
          manifest: data.manifest,
          createdAt: now,
          updatedAt: now,
          scos: (data.scos?.create ?? []).map((s: any, i: number) => ({
            id: `sco_${i}`,
            courseId: data.id,
            identifier: s.identifier,
            title: s.title,
            launchHref: s.launchHref,
            parameters: s.parameters ?? null,
            order: s.order ?? i,
          })),
        };
        courses.push(row);
        return row;
      },
      findUniqueOrThrow: async ({ where, include }: { where: { id: string }; include?: any }) => {
        const row = courses.find((c) => c.id === where.id);
        if (!row) throw new Error('not found');
        return include?.scos ? row : { ...row, scos: undefined };
      },
      findFirst: async ({ where, include }: { where: any; include?: any }) => {
        const row = courses.find(
          (c) => c.tenantId === where.tenantId && (!where.id || c.id === where.id),
        );
        if (!row) return null;
        if (where.select) {
          const out: any = {};
          for (const k of Object.keys(where.select)) out[k] = (row as any)[k];
          return out;
        }
        return include?.scos ? row : { ...row, scos: undefined };
      },
      findMany: async ({ where, include: _include }: { where: any; include?: any; orderBy?: any; take?: number }) => {
        return courses.filter((c) => c.tenantId === where.tenantId);
      },
      update: async ({ where, data }: { where: { id: string }; data: any }) => {
        const row = courses.find((c) => c.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return row;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const idx = courses.findIndex((c) => c.id === where.id);
        if (idx >= 0) courses.splice(idx, 1);
        return { id: where.id };
      },
    },
    courseVersion: {
      create: async ({ data }: { data: any }) => {
        const row = { id: randomUUID(), createdAt: new Date(), ...data };
        versions.push(row);
        return row;
      },
      findMany: async ({ where }: { where: { courseId: string } }) =>
        versions.filter((v) => v.courseId === where.courseId),
    },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
  } as unknown as PrismaClient;

  return {
    prisma,
    state: { courses, versions, apiKeys, tenantId, apiKeyPlaintext },
  };
}
