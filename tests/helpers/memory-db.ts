import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '../../src/db/client.js';
import { hashApiKey } from '../../src/auth/api-key.js';

type Row = Record<string, any>;

export interface MemoryDbSeed {
  tenantId: string;
  apiKey: string;
}

export interface MemoryDb {
  prisma: PrismaClient;
  tables: {
    courses: Row[];
    courseVersions: Row[];
    scos: Row[];
    learners: Row[];
    attempts: Row[];
    objectives: Row[];
    interactions: Row[];
    commitLogs: Row[];
    certificates: Row[];
    aiConfigs: Row[];
    aiCalls: Row[];
    replayEvents: Row[];
  };
}

/**
 * A stateful in-memory stand-in for the Prisma surface the SCORM lifecycle
 * touches (courses → SCOs → learners → attempts → child rows). Unlike the
 * per-route fakes it evaluates `where` filters, `select` / `include`
 * projections and relations generically, so one instance can carry a course
 * through upload, launch, tracking, resume and completion end to end.
 */
export function createMemoryDb(seed: MemoryDbSeed): MemoryDb {
  const tables: MemoryDb['tables'] = {
    courses: [],
    courseVersions: [],
    scos: [],
    learners: [],
    attempts: [],
    objectives: [],
    interactions: [],
    commitLogs: [],
    certificates: [],
    aiConfigs: [],
    aiCalls: [],
    replayEvents: [],
  };

  // Relations each model can expand through select/include.
  const relations: Record<string, Record<string, (row: Row) => Row | Row[] | null>> = {
    course: {
      scos: (c) => sortBy(tables.scos.filter((s) => s.courseId === c.id), 'order'),
      currentVersion: (c) => tables.courseVersions.find((v) => v.id === c.currentVersionId) ?? null,
    },
    attempt: {
      course: (a) => tables.courses.find((c) => c.id === a.courseId) ?? null,
      learner: (a) => tables.learners.find((l) => l.id === a.learnerId) ?? null,
      courseVersion: (a) => tables.courseVersions.find((v) => v.id === a.courseVersionId) ?? null,
      objectives: (a) => sortBy(tables.objectives.filter((o) => o.attemptId === a.id), 'index'),
      interactions: (a) => sortBy(tables.interactions.filter((i) => i.attemptId === a.id), 'index'),
    },
    certificate: {
      learner: (c) => tables.learners.find((l) => l.id === c.learnerId) ?? null,
    },
  };

  function project(model: string, row: Row, args: { select?: any; include?: any }): Row {
    const rels = relations[model] ?? {};
    const expand = (key: string, spec: any) => {
      const value = rels[key]!(row);
      if (spec === true || value === null) return value;
      const nestedModel = key === 'course' ? 'course' : key;
      return Array.isArray(value)
        ? value.map((v) => project(nestedModel, v, spec))
        : project(nestedModel, value, spec);
    };
    if (args.select) {
      const out: Row = {};
      for (const [key, spec] of Object.entries(args.select)) {
        if (!spec) continue;
        out[key] = rels[key] ? expand(key, spec) : row[key];
      }
      return out;
    }
    const out: Row = { ...row };
    for (const [key, spec] of Object.entries(args.include ?? {})) {
      if (spec && rels[key]) out[key] = expand(key, spec);
    }
    return out;
  }

  function table(model: string, rows: Row[], defaults: (data: Row) => Row) {
    const filter = (where: Row = {}) => rows.filter((r) => matches(r, where));
    return {
      findUnique: async (args: any) => {
        const row = filter(args.where)[0];
        return row ? project(model, row, args) : null;
      },
      findUniqueOrThrow: async (args: any) => {
        const row = filter(args.where)[0];
        if (!row) throw new Error(`${model} not found`);
        return project(model, row, args);
      },
      findFirst: async (args: any) => {
        const found = order(filter(args.where), args.orderBy)[0];
        return found ? project(model, found, args) : null;
      },
      findMany: async (args: any = {}) =>
        order(filter(args.where), args.orderBy)
          .slice(0, args.take ?? undefined)
          .map((r) => project(model, r, args)),
      count: async (args: any = {}) => filter(args.where).length,
      aggregate: async (args: any = {}) => {
        const found = filter(args.where);
        const out: Row = {};
        for (const op of ['_sum', '_avg'] as const) {
          if (!args[op]) continue;
          out[op] = {};
          for (const field of Object.keys(args[op])) {
            const values = found.map((r) => r[field]).filter((v) => v != null) as number[];
            const sum = values.reduce((s, v) => s + v, 0);
            out[op][field] = values.length === 0 ? null : op === '_sum' ? sum : sum / values.length;
          }
        }
        if (args._count) out._count = { _all: found.length };
        return out;
      },
      create: async (args: any) => {
        const { nested, data } = splitNested(args.data);
        const row = { ...defaults(data), ...data };
        rows.push(row);
        if (model === 'course' && nested.scos) {
          nested.scos.create.forEach((s: Row, i: number) =>
            tables.scos.push({ id: randomUUID(), courseId: row.id, parameters: null, order: i, ...s }),
          );
        }
        return project(model, row, args);
      },
      createMany: async (args: any) => {
        for (const data of args.data) rows.push({ ...defaults(data), ...data });
        return { count: args.data.length };
      },
      update: async (args: any) => {
        const row = filter(args.where)[0];
        if (!row) throw new Error(`${model} not found`);
        Object.assign(row, args.data);
        return project(model, row, args);
      },
      upsert: async (args: any) => {
        const key = Object.values(args.where)[0] as Row;
        const existing = rows.find((r) => matches(r, key));
        if (existing) {
          Object.assign(existing, args.update);
          return project(model, existing, args);
        }
        const row = { ...defaults(args.create), ...args.create };
        rows.push(row);
        return project(model, row, args);
      },
      delete: async (args: any) => {
        const row = filter(args.where)[0];
        if (!row) throw new Error(`${model} not found`);
        rows.splice(rows.indexOf(row), 1);
        if (model === 'course') cascadeCourse(row.id);
        return row;
      },
      deleteMany: async (args: any = {}) => {
        const doomed = filter(args.where);
        for (const row of doomed) rows.splice(rows.indexOf(row), 1);
        return { count: doomed.length };
      },
    };
  }

  function cascadeCourse(courseId: string) {
    const attemptIds = new Set(tables.attempts.filter((a) => a.courseId === courseId).map((a) => a.id));
    const keep = (rows: Row[], drop: (r: Row) => boolean) => {
      const remaining = rows.filter((r) => !drop(r));
      rows.length = 0;
      rows.push(...remaining);
    };
    keep(tables.scos, (s) => s.courseId === courseId);
    keep(tables.courseVersions, (v) => v.courseId === courseId);
    keep(tables.attempts, (a) => attemptIds.has(a.id));
    keep(tables.objectives, (o) => attemptIds.has(o.attemptId));
    keep(tables.interactions, (i) => attemptIds.has(i.attemptId));
    keep(tables.commitLogs, (l) => attemptIds.has(l.attemptId));
    keep(tables.certificates, (c) => attemptIds.has(c.attemptId));
    keep(tables.replayEvents, (e) => attemptIds.has(e.attemptId));
  }

  const now = () => new Date();
  const client: Row = {
    apiKey: {
      findUnique: async ({ where }: any) =>
        where.hashedKey === hashApiKey(seed.apiKey)
          ? { id: 'apikey_e2e', tenantId: seed.tenantId, revokedAt: null }
          : null,
    },
    course: table('course', tables.courses, () => ({
      id: randomUUID(),
      description: null,
      masteryScore: null,
      currentVersionId: null,
      createdAt: now(),
      updatedAt: now(),
    })),
    courseVersion: table('courseVersion', tables.courseVersions, () => ({
      id: randomUUID(),
      releaseNotes: null,
      description: null,
      masteryScore: null,
      files: null,
      fileCount: 0,
      sizeBytes: 0n,
      packageSha256: null,
      createdAt: now(),
    })),
    sco: table('sco', tables.scos, () => ({ id: randomUUID() })),
    learner: table('learner', tables.learners, () => ({ id: randomUUID(), name: null, createdAt: now() })),
    attempt: table('attempt', tables.attempts, () => ({
      id: randomUUID(),
      scoId: null,
      courseVersionId: null,
      status: 'IN_PROGRESS',
      lessonStatus: 'NOT_ATTEMPTED',
      completionStatus: 'NOT_ATTEMPTED',
      successStatus: 'UNKNOWN',
      lessonLocation: null,
      suspendData: null,
      scoreRaw: null,
      scoreMin: null,
      scoreMax: null,
      scoreScaled: null,
      progressMeasure: null,
      sessionTimeSeconds: 0,
      totalTimeSeconds: 0,
      cmiSnapshot: {},
      startedAt: now(),
      lastCommitAt: null,
      finishedAt: null,
    })),
    objective: table('objective', tables.objectives, () => ({ id: randomUUID() })),
    interaction: table('interaction', tables.interactions, () => ({ id: randomUUID() })),
    commitLog: table('commitLog', tables.commitLogs, () => ({ id: randomUUID(), createdAt: now() })),
    certificate: table('certificate', tables.certificates, () => ({
      id: randomUUID(),
      scorePercent: null,
      issuedAt: now(),
      revokedAt: null,
      revokedReason: null,
    })),
    aiProviderConfig: table('aiProviderConfig', tables.aiConfigs, () => ({
      id: randomUUID(),
      createdAt: now(),
      updatedAt: now(),
    })),
    aiCallLog: table('aiCallLog', tables.aiCalls, () => ({ id: randomUUID(), createdAt: now() })),
    replayEvent: table('replayEvent', tables.replayEvents, () => ({
      id: randomUUID(),
      clientId: null,
      location: null,
      data: {},
      createdAt: now(),
    })),
  };
  client.$transaction = async (fn: (tx: unknown) => unknown) => fn(client);

  return { prisma: client as unknown as PrismaClient, tables };
}

/** Evaluate the subset of Prisma's where-clause grammar the engine uses. */
function matches(row: Row, where: Row): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    const value = row[key];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('in' in cond && !cond.in.includes(value)) return false;
      if ('not' in cond && (value ?? null) === cond.not) return false;
      if ('lt' in cond && !(value < cond.lt)) return false;
      if ('gte' in cond && !(value >= cond.gte)) return false;
      if (!('in' in cond) && !('not' in cond) && !('lt' in cond) && !('gte' in cond) && !matches(row, cond)) {
        return false;
      }
      continue;
    }
    if (value !== cond && !(cond === null && value === undefined)) return false;
  }
  return true;
}

function order(rows: Row[], orderBy: Row | undefined): Row[] {
  if (!orderBy) return rows;
  const [key, dir] = Object.entries(orderBy)[0] as [string, 'asc' | 'desc'];
  const sorted = sortBy(rows, key);
  return dir === 'desc' ? sorted.reverse() : sorted;
}

function sortBy(rows: Row[], key: string): Row[] {
  return [...rows].sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0));
}

/** Pull nested relation writes (`{ scos: { create: [...] } }`) out of create data. */
function splitNested(input: Row): { data: Row; nested: Row } {
  const data: Row = {};
  const nested: Row = {};
  for (const [key, value] of Object.entries(input)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && 'create' in value) nested[key] = value;
    else data[key] = value;
  }
  return { data, nested };
}
