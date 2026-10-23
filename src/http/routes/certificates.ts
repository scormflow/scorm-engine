import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from 'fastify';

import { CertificateError, type CertificateIssuer } from '../../certificates/index.js';

export interface CertificateRouteDeps {
  certificates: CertificateIssuer;
}

interface PdfQuery {
  /** `1`/`true` to download (Content-Disposition: attachment) instead of view inline. */
  download?: string;
}

/**
 * Completion certificates.
 *
 *  - `/certificates…` — tenant-scoped management by API key, plus a public
 *    `GET /certificates/verify/:serial` anyone holding the printed code can use;
 *  - `/attempts/:id/certificate…` — the learner-facing view. A browser player
 *    reads it with its attempt token (header, `?token=` or cookie); issuing on
 *    demand needs the API key.
 */
export function certificateRoutes(deps: CertificateRouteDeps): FastifyPluginAsync {
  const { certificates } = deps;

  return async function (app: FastifyInstance): Promise<void> {
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof CertificateError) {
        return reply.code(err.status).send({ code: err.code, message: err.message });
      }
      return reply.send(err);
    });

    const auth = { preHandler: app.requireApiKey };
    const attemptAuth = { preHandler: app.requireAttemptAccess };

    app.get<{
      Querystring: { learnerId?: string; courseId?: string; status?: string; limit?: string; before?: string };
    }>('/certificates', auth, async (req) =>
      certificates.list({
        tenantId: req.tenantId,
        learnerId: req.query.learnerId,
        courseId: req.query.courseId,
        status: req.query.status,
        limit: req.query.limit ? Number(req.query.limit) || undefined : undefined,
        before: req.query.before,
      }),
    );

    // Public: no credentials, reveals only what is printed on the certificate.
    app.get<{ Params: { serial: string } }>('/certificates/verify/:serial', async (req, reply) => {
      const result = await certificates.verify(req.params.serial);
      if (!result) {
        return reply.code(404).send({ code: 'certificate_not_found', message: 'No certificate has this code' });
      }
      return result;
    });

    app.get<{ Params: { id: string } }>('/certificates/:id', auth, async (req) =>
      certificates.get(req.tenantId, req.params.id),
    );

    app.get<{ Params: { id: string }; Querystring: PdfQuery }>('/certificates/:id/pdf', auth, async (req, reply) =>
      sendPdf(reply, await certificates.renderPdf(req.tenantId, { id: req.params.id }), req.query),
    );

    app.post<{ Params: { id: string }; Body: { reason?: string } }>(
      '/certificates/:id/revoke',
      auth,
      async (req, reply) => {
        const reason = req.body?.reason;
        if (reason !== undefined && (typeof reason !== 'string' || reason.length > 500)) {
          return reply
            .code(400)
            .send({ code: 'invalid_request', message: 'reason must be a string of at most 500 characters' });
        }
        return certificates.revoke(req.tenantId, req.params.id, reason);
      },
    );

    app.get<{ Params: { id: string } }>('/attempts/:id/certificate', attemptAuth, async (req) =>
      certificates.getForAttempt(req.tenantId, req.params.id),
    );

    app.get<{ Params: { id: string }; Querystring: PdfQuery }>(
      '/attempts/:id/certificate/pdf',
      attemptAuth,
      async (req, reply) =>
        sendPdf(reply, await certificates.renderPdf(req.tenantId, { attemptId: req.params.id }), req.query),
    );

    app.post<{ Params: { id: string } }>('/attempts/:id/certificate', auth, async (req, reply) => {
      const { certificate, created } = await certificates.issueForAttempt(req.tenantId, req.params.id);
      reply.code(created ? 201 : 200);
      return certificate;
    });
  };
}

function sendPdf(reply: FastifyReply, rendered: { pdf: Buffer; serial: string }, query: PdfQuery) {
  const disposition = query.download === '1' || query.download === 'true' ? 'attachment' : 'inline';
  return reply
    .type('application/pdf')
    .header('content-disposition', `${disposition}; filename="certificate-${rendered.serial}.pdf"`)
    .header('cache-control', 'private, no-store')
    .send(rendered.pdf);
}
