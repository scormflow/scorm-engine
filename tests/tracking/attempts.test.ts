import { describe, expect, it } from 'vitest';

import type { PrismaClient } from '../../src/db/client.js';
import type { CmiState, CmiSummary } from '../../src/runtime/datamodel/types.js';
import {
  AttemptServiceError,
  recordCommit,
  startOrResumeAttempt,
} from '../../src/tracking/attempts.js';

/**
 * Minimal in-memory Prisma stand-in covering only the attempt/learner/course
 * operations the tracking service touches — enough to exercise start/resume and
 * commit persistence without a real database.
 */
function fakePrisma(opts: {
  course?: { id: string; scormVersion: string; masteryScore: number | null };
} = {}) {
  const state = {
    learners: [] as any[],
    attempts: [] as any[],
    objectives: [] as any[],
    interactions: [] as any[],
    commitLogs: [] as any[],
    seq: 0,
  };
  const id = (p: string) => `${p}_${++state.seq}`;
  const course = opts.course ?? { id: 'course_1', scormVersion: 'SCORM_2004_4', masteryScore: 80 };

  const client = {
    course: {
      findFirst: async ({ where }: any) =>
        where.id === course.id && where.tenantId ? course : null,
    },
    learner: {
      upsert: async ({ where, create }: any) => {
        let row = state.learners.find(
          (l) =>
            l.tenantId === where.tenantId_externalId.tenantId &&
            l.externalId === where.tenantId_externalId.externalId,
        );
        if (!row) {
          row = { id: id('learner'), ...create };
          state.learners.push(row);
        }
        return { id: row.id };
      },
    },
    attempt: {
      findFirst: async ({ where }: any) => {
        return (
          state.attempts.find(
            (a) =>
              (where.id ? a.id === where.id : true) &&
              (where.tenantId ? a.tenantId === where.tenantId : true) &&
              (where.status ? a.status === where.status : true) &&
              (where.learnerId ? a.learnerId === where.learnerId : true) &&
              (where.scoId !== undefined ? a.scoId === where.scoId : true),
          ) ?? null
        );
      },
      findMany: async ({ where }: any) => {
        return state.attempts.filter(
          (a) =>
            a.tenantId === where.tenantId &&
            a.courseId === where.courseId &&
            a.learnerId === where.learnerId &&
            (where.status?.in ? where.status.in.includes(a.status) : true) &&
            (where.id?.not ? a.id !== where.id.not : true),
        );
      },
      create: async ({ data }: any) => {
        const row = {
          id: id('attempt'),
          sessionTimeSeconds: 0,
          totalTimeSeconds: 0,
          scoId: null,
          ...data,
        };
        state.attempts.push(row);
        return { id: row.id };
      },
      update: async ({ where, data }: any) => {
        const row = state.attempts.find((a) => a.id === where.id);
        Object.assign(row, data);
        return row;
      },
    },
    objective: {
      deleteMany: async ({ where }: any) => {
        state.objectives = state.objectives.filter((o) => o.attemptId !== where.attemptId);
      },
      createMany: async ({ data }: any) => {
        state.objectives.push(...data);
      },
    },
    interaction: {
      deleteMany: async ({ where }: any) => {
        state.interactions = state.interactions.filter((i) => i.attemptId !== where.attemptId);
      },
      createMany: async ({ data }: any) => {
        state.interactions.push(...data);
      },
    },
    commitLog: {
      create: async ({ data }: any) => {
        state.commitLogs.push(data);
      },
    },
    $transaction: async (fn: any) => fn(client),
  } as unknown as PrismaClient;

  return { prisma: client, state };
}

function summary(overrides: Partial<CmiSummary> = {}): CmiSummary {
  return {
    completionStatus: 'unknown',
    successStatus: 'unknown',
    scoreRaw: null,
    scoreMin: null,
    scoreMax: null,
    scoreScaled: null,
    progressMeasure: null,
    lessonLocation: null,
    suspendData: null,
    sessionTime: null,
    exit: null,
    ...overrides,
  };
}

describe('startOrResumeAttempt', () => {
  it('creates a fresh ab-initio attempt', async () => {
    const { prisma, state } = fakePrisma();
    const started = await startOrResumeAttempt(
      { tenantId: 't1', courseId: 'course_1', learnerExternalId: 'u1', learnerName: 'Ada' },
      prisma,
    );
    expect(started.resumed).toBe(false);
    expect(started.context.entry).toBe('ab-initio');
    expect(started.context.learnerName).toBe('Ada');
    expect(started.context.masteryScore).toBe(80);
    expect(started.resumeState).toBeUndefined();
    expect(state.attempts).toHaveLength(1);
  });

  it('resumes an open attempt and returns its snapshot', async () => {
    const { prisma, state } = fakePrisma();
    state.learners.push({ id: 'learner_x', tenantId: 't1', externalId: 'u1' });
    state.attempts.push({
      id: 'attempt_open',
      tenantId: 't1',
      courseId: 'course_1',
      learnerId: 'learner_x',
      scoId: null,
      status: 'IN_PROGRESS',
      sessionTimeSeconds: 0,
      totalTimeSeconds: 0,
      cmiSnapshot: { 'cmi.location': 'page-3' },
    });

    const started = await startOrResumeAttempt(
      { tenantId: 't1', courseId: 'course_1', learnerExternalId: 'u1' },
      prisma,
    );
    expect(started.resumed).toBe(true);
    expect(started.attemptId).toBe('attempt_open');
    expect(started.context.entry).toBe('resume');
    expect(started.resumeState).toEqual({ 'cmi.location': 'page-3' });
  });

  it('starts a new attempt when restart is forced', async () => {
    const { prisma, state } = fakePrisma();
    state.learners.push({ id: 'learner_x', tenantId: 't1', externalId: 'u1' });
    state.attempts.push({
      id: 'attempt_open',
      tenantId: 't1',
      courseId: 'course_1',
      learnerId: 'learner_x',
      scoId: null,
      status: 'IN_PROGRESS',
      sessionTimeSeconds: 0,
      totalTimeSeconds: 0,
    });

    const started = await startOrResumeAttempt(
      { tenantId: 't1', courseId: 'course_1', learnerExternalId: 'u1', restart: true },
      prisma,
    );
    expect(started.resumed).toBe(false);
    expect(state.attempts).toHaveLength(2);
  });

  it('rejects an unknown course', async () => {
    const { prisma } = fakePrisma();
    await expect(
      startOrResumeAttempt(
        { tenantId: 't1', courseId: 'nope', learnerExternalId: 'u1' },
        prisma,
      ),
    ).rejects.toBeInstanceOf(AttemptServiceError);
  });

  it('seeds total_time from prior finished attempts', async () => {
    const { prisma, state } = fakePrisma();
    state.learners.push({ id: 'learner_x', tenantId: 't1', externalId: 'u1' });
    state.attempts.push({
      id: 'attempt_done',
      tenantId: 't1',
      courseId: 'course_1',
      learnerId: 'learner_x',
      scoId: null,
      status: 'COMPLETED',
      sessionTimeSeconds: 600,
      totalTimeSeconds: 600,
    });

    const started = await startOrResumeAttempt(
      { tenantId: 't1', courseId: 'course_1', learnerExternalId: 'u1' },
      prisma,
    );
    // 600s prior → ISO 8601 PT10M for SCORM 2004.
    expect(started.context.totalTime).toBe('PT10M');
  });
});

describe('recordCommit', () => {
  const state: CmiState = {
    'cmi.completion_status': 'completed',
    'cmi.success_status': 'passed',
    'cmi.score.scaled': '0.9',
    'cmi.objectives.0.id': 'obj-1',
    'cmi.objectives.0.success_status': 'passed',
    'cmi.interactions.0.id': 'q1',
    'cmi.interactions.0.type': 'choice',
    'cmi.interactions.0.learner_response': 'a',
  };

  it('persists rollup, objectives, interactions and a commit log', async () => {
    const { prisma, state: db } = fakePrisma();
    db.attempts.push({
      id: 'a1',
      tenantId: 't1',
      courseId: 'course_1',
      learnerId: 'learner_x',
      scoId: null,
      status: 'IN_PROGRESS',
      sessionTimeSeconds: 0,
      totalTimeSeconds: 0,
    });

    await recordCommit(
      {
        tenantId: 't1',
        attemptId: 'a1',
        state,
        summary: summary({
          completionStatus: 'completed',
          successStatus: 'passed',
          scoreScaled: 0.9,
          sessionTime: 'PT5M',
        }),
        version: 'SCORM_2004_4',
      },
      prisma,
    );

    const row = db.attempts[0];
    expect(row.status).toBe('IN_PROGRESS');
    expect(row.completionStatus).toBe('COMPLETED');
    expect(row.successStatus).toBe('PASSED');
    expect(row.scoreScaled).toBe(0.9);
    expect(row.sessionTimeSeconds).toBe(300);
    expect(db.objectives).toHaveLength(1);
    expect(db.interactions).toHaveLength(1);
    expect(db.commitLogs).toHaveLength(1);
  });

  it('closes the attempt as COMPLETED on a terminal commit', async () => {
    const { prisma, state: db } = fakePrisma();
    db.attempts.push({
      id: 'a1',
      tenantId: 't1',
      courseId: 'course_1',
      learnerId: 'learner_x',
      scoId: null,
      status: 'IN_PROGRESS',
      sessionTimeSeconds: 0,
      totalTimeSeconds: 0,
    });

    await recordCommit(
      {
        tenantId: 't1',
        attemptId: 'a1',
        state,
        summary: summary({ completionStatus: 'completed', successStatus: 'passed' }),
        version: 'SCORM_2004_4',
        terminal: true,
      },
      prisma,
    );
    expect(db.attempts[0].status).toBe('COMPLETED');
    expect(db.attempts[0].finishedAt).toBeInstanceOf(Date);
  });

  it('replaces child rows on re-commit rather than appending', async () => {
    const { prisma, state: db } = fakePrisma();
    db.attempts.push({
      id: 'a1',
      tenantId: 't1',
      courseId: 'course_1',
      learnerId: 'learner_x',
      scoId: null,
      status: 'IN_PROGRESS',
      sessionTimeSeconds: 0,
      totalTimeSeconds: 0,
    });

    const commit = () =>
      recordCommit(
        {
          tenantId: 't1',
          attemptId: 'a1',
          state,
          summary: summary({ completionStatus: 'incomplete' }),
          version: 'SCORM_2004_4',
        },
        prisma,
      );
    await commit();
    await commit();
    expect(db.objectives).toHaveLength(1);
    expect(db.interactions).toHaveLength(1);
    expect(db.commitLogs).toHaveLength(2); // audit log accumulates
  });

  it('rejects committing to a finished attempt', async () => {
    const { prisma, state: db } = fakePrisma();
    db.attempts.push({
      id: 'a1',
      tenantId: 't1',
      courseId: 'course_1',
      learnerId: 'learner_x',
      scoId: null,
      status: 'COMPLETED',
      sessionTimeSeconds: 0,
      totalTimeSeconds: 0,
    });

    await expect(
      recordCommit(
        {
          tenantId: 't1',
          attemptId: 'a1',
          state,
          summary: summary(),
          version: 'SCORM_2004_4',
        },
        prisma,
      ),
    ).rejects.toMatchObject({ code: 'attempt_finished', status: 409 });
  });
});
