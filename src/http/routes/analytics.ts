import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

import type { PrismaClient } from '../../db/client.js';
import {
  MAX_SCORE_BINS,
  MAX_TREND_DAYS,
  MIN_SCORE_BINS,
  getCourseAnalytics,
  getLearnerAnalytics,
  getOverview,
  getScoreDistribution,
  getTrends,
} from '../../analytics/index.js';

export interface AnalyticsRouteDeps {
  prisma: PrismaClient;
}

/** Read-only analytics endpoints under `/analytics/*`. */
export function analyticsRoutes(deps: AnalyticsRouteDeps): FastifyPluginAsync {
  const { prisma } = deps;

  const courseExists = async (tenantId: string, courseId: string): Promise<boolean> =>
    (await prisma.course.findFirst({ where: { id: courseId, tenantId }, select: { id: true } })) != null;

  return async function (app: FastifyInstance): Promise<void> {
    app.get('/overview', { preHandler: app.requireApiKey }, async (req) => {
      return getOverview(req.tenantId, prisma);
    });

    app.get<{ Querystring: { days?: string; courseId?: string } }>(
      '/trends',
      { preHandler: app.requireApiKey },
      async (req, reply) => {
        const { days, courseId } = req.query;
        const parsedDays = days === undefined ? undefined : Number(days);
        if (parsedDays !== undefined && (!Number.isInteger(parsedDays) || parsedDays < 1 || parsedDays > MAX_TREND_DAYS)) {
          return reply
            .code(400)
            .send({ code: 'invalid_request', message: `days must be an integer between 1 and ${MAX_TREND_DAYS}` });
        }
        if (courseId !== undefined && !(await courseExists(req.tenantId, courseId))) {
          return reply.code(404).send({ code: 'course_not_found', message: 'Course not found' });
        }
        return getTrends(req.tenantId, prisma, { days: parsedDays, courseId });
      },
    );

    app.get<{ Params: { courseId: string } }>(
      '/courses/:courseId',
      { preHandler: app.requireApiKey },
      async (req, reply) => {
        if (!(await courseExists(req.tenantId, req.params.courseId))) {
          return reply.code(404).send({ code: 'course_not_found', message: 'Course not found' });
        }
        return getCourseAnalytics(req.tenantId, req.params.courseId, prisma);
      },
    );

    app.get<{ Params: { courseId: string }; Querystring: { bins?: string } }>(
      '/courses/:courseId/scores',
      { preHandler: app.requireApiKey },
      async (req, reply) => {
        const { bins } = req.query;
        const parsedBins = bins === undefined ? undefined : Number(bins);
        if (
          parsedBins !== undefined &&
          (!Number.isInteger(parsedBins) || parsedBins < MIN_SCORE_BINS || parsedBins > MAX_SCORE_BINS)
        ) {
          return reply.code(400).send({
            code: 'invalid_request',
            message: `bins must be an integer between ${MIN_SCORE_BINS} and ${MAX_SCORE_BINS}`,
          });
        }
        if (!(await courseExists(req.tenantId, req.params.courseId))) {
          return reply.code(404).send({ code: 'course_not_found', message: 'Course not found' });
        }
        return getScoreDistribution(req.tenantId, req.params.courseId, prisma, parsedBins);
      },
    );

    app.get<{ Params: { learnerId: string } }>(
      '/learners/:learnerId',
      { preHandler: app.requireApiKey },
      async (req, reply) => {
        const analytics = await getLearnerAnalytics(req.tenantId, req.params.learnerId, prisma);
        if (!analytics) {
          return reply.code(404).send({ code: 'learner_not_found', message: 'Learner not found' });
        }
        return analytics;
      },
    );
  };
}
