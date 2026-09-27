import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

import type { PrismaClient } from '../../db/client.js';
import {
  getCourseAnalytics,
  getLearnerAnalytics,
  getOverview,
} from '../../analytics/index.js';

export interface AnalyticsRouteDeps {
  prisma: PrismaClient;
}

/** Read-only analytics endpoints under `/analytics/*`. */
export function analyticsRoutes(deps: AnalyticsRouteDeps): FastifyPluginAsync {
  const { prisma } = deps;

  return async function (app: FastifyInstance): Promise<void> {
    app.get('/overview', { preHandler: app.requireApiKey }, async (req) => {
      return getOverview(req.tenantId, prisma);
    });

    app.get<{ Params: { courseId: string } }>(
      '/courses/:courseId',
      { preHandler: app.requireApiKey },
      async (req, reply) => {
        const course = await prisma.course.findFirst({
          where: { id: req.params.courseId, tenantId: req.tenantId },
          select: { id: true },
        });
        if (!course) {
          return reply.code(404).send({ code: 'course_not_found', message: 'Course not found' });
        }
        return getCourseAnalytics(req.tenantId, req.params.courseId, prisma);
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
