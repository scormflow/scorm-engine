# ScormFlow — Server

> **Open-source infrastructure for SCORM, xAPI, and cmi5 — with built-in LRS, webhooks, and AI analytics.**
> Headless, API-first runtime engine. Embed it in a Node app, run it as a Docker container, or pair it with [`@scormflow/react`](https://github.com/scormflow/scorm-engine-client). Vendor-neutral REST API, end-to-end typed.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)](tsconfig.json)

---

## Why ScormFlow

Existing open-source SCORM projects are either runtime libraries (no persistence) or full LMS forks (everything you don't want). ScormFlow is the missing middle: a small, embeddable engine that handles parsing, runtime APIs, tracking, and analytics — and stops there. You compose the LMS on top.

- **Pluggable everywhere** — storage (local / S3 / R2 / MinIO), auth (API key / JWT), database (Postgres / SQLite), AI provider (BYO key).
- **Standards-first** — SCORM 1.2, SCORM 2004, xAPI, and cmi5 share one normalized event model.
- **Headless** — every UI feature in the ecosystem is built on the public REST API. No private endpoints.
- **Zero third-party SCORM libraries** — clean-room implementation of the SCORM JS APIs. Any spec-compliant course works.

---

## Quick Start

### Docker

```bash
git clone https://github.com/scormflow/scorm-engine.git
cd scorm-engine
cp .env.example .env
docker compose -f docker/docker-compose.yml up
```

The engine is now live on `http://localhost:3000`. Health check: `GET /healthz`.

### Embed in a Node app

```bash
npm install @scormflow/server
```

```ts
import { buildApp, loadEnv } from '@scormflow/server';

const env = loadEnv();
const app = await buildApp({ env });
await app.listen({ port: 3000 });
```

---

## REST API (excerpt)

Full spec: [`openapi/openapi.yaml`](openapi/openapi.yaml).

```
POST   /api/v1/courses               Upload + register a SCORM package
POST   /api/v1/courses/validate      Validate a package without registering
GET    /api/v1/courses               List courses for the tenant
GET    /api/v1/courses/:id           Course metadata + SCO tree
DELETE /api/v1/courses/:id           Delete a course

POST   /api/v1/attempts/start        Start a learner attempt
GET    /api/v1/attempts/:id          Attempt state
POST   /api/v1/attempts/:id/finish   Force-terminate an attempt

POST   /api/v1/runtime/:attemptId/initialize    SCORM Initialize
POST   /api/v1/runtime/:attemptId/value         SetValue / GetValue
POST   /api/v1/runtime/:attemptId/commit        Commit
POST   /api/v1/runtime/:attemptId/terminate     Terminate

GET    /api/v1/analytics/courses/:id
GET    /api/v1/analytics/learners/:id
GET    /api/v1/analytics/overview
```

Auth: `Authorization: Bearer <api-key>` for tenant calls; short-lived JWT for runtime calls (issued per attempt).

---

## Architecture

```
src/
├── core/         Runtime engine (CMI model, validators)        [planned]
├── parser/       imsmanifest.xml + ZIP extraction              [done]
├── runtime/      SCORM 1.2 + 2004 API handlers                 [planned]
├── tracking/     Attempt + progress persistence                [planned]
├── storage/      Pluggable storage adapters                    [local done, S3 planned]
├── analytics/    Analytics + reporting                         [planned]
├── http/         Fastify routes + middleware                   [partial]
├── auth/         API keys + JWT                                [api-key done, jwt planned]
├── services/     Course / attempt / runtime services           [course done]
├── db/           Prisma schema + migrations                    [done]
└── server.ts     Entrypoint
```

Database: PostgreSQL (production) or SQLite (dev). ORM: Prisma. Schema in [`prisma/schema.prisma`](prisma/schema.prisma).

---

## Configuration

`.env` (see [`.env.example`](.env.example) for the full list):

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Postgres / SQLite connection string |
| `STORAGE_DRIVER` | `local`, `s3` |
| `STORAGE_LOCAL_DIR` | Disk path for local driver |
| `JWT_SECRET` | Signing secret for runtime tokens |
| `API_BASE_URL` | Public base URL (used in `/play/:attemptId` links) |

---

## Roadmap

Checkboxes reflect the actual state of `main`.

### Phase 1 — MVP (foundation)
- [x] Repo init, TypeScript strict mode, Fastify app skeleton
- [x] Prisma schema (Tenant, ApiKey, Course, Sco, Learner, Attempt, Interaction, Objective, CommitLog)
- [x] Pluggable `StorageAdapter` interface + local disk driver
- [x] SCORM ZIP extraction (yauzl)
- [x] `imsmanifest.xml` parser (fast-xml-parser)
- [x] SCORM 1.2 / 2004 version detection
- [x] Course ingestion service (upload → extract → parse → persist)
- [x] Course management routes (upload, list, get, delete)
- [x] Package validation endpoint (`POST /courses/validate`)
- [x] API key auth + tenant scoping (`requireApiKey` preHandler)
- [x] OpenAPI 3.1 spec as source of truth
- [x] Dockerfile + docker-compose (engine + Postgres)
- [ ] S3 / R2 / MinIO storage driver
- [ ] JWT issuance for runtime / player tokens
- [ ] Attempt lifecycle routes (`/attempts/start`, `/:id`, `/:id/finish`)
- [x] CMI data model + value validation (SCORM 1.2)
- [x] CMI data model + value validation (SCORM 2004)
- [ ] Runtime API routes (`initialize` / `value` / `commit` / `terminate`)
- [ ] Resume support (suspend_data, lesson_location persistence)
- [ ] Basic analytics endpoints (course / learner / overview)
- [ ] Standalone iframe player route (`GET /play/:attemptId`)
- [ ] Drop-in runtime bridge (`GET /runtime.js`)
- [ ] Multi-tenant rate limiting + isolated storage prefixes
- [ ] End-to-end test: upload → launch → track → resume → complete

### Phase 2 — Strong differentiators
- [ ] xAPI 1.0.3 statement endpoint + state / activity / agent profile APIs
- [ ] Built-in LRS (xAPI store, queryable, pluggable backend)
- [ ] cmi5 launch + registration management
- [ ] cmi5 session lifecycle (initialized → completed / passed / failed / terminated / abandoned)
- [ ] Webhook system (signed payloads, retries, delivery log)
- [ ] Offline sync queue + reconciliation
- [ ] Certificate engine (PDF generation on completion)
- [ ] Event bus (BullMQ / Redis streams)
- [ ] Plugin system (`plugins: [analyticsPlugin(), certificatePlugin()]`)

### Phase 3 — Category-defining
- [ ] AI analytics layer with BYO provider + key (OpenAI / Anthropic / Gemini / Mistral / Ollama)
- [ ] PII redaction pass for AI prompts
- [ ] Session replay (event timeline, heatmaps, engagement scoring)
- [ ] Git-style course versioning (releases, diffs, rollback)
- [ ] Universal Learning Content Gateway (SCORM / xAPI / cmi5 / H5P / HTML / video / PDF)
- [ ] Compliance dashboards (audit log, attestation, certification expiry)
- [ ] Learning data warehouse export (BigQuery / Snowflake / Redshift / S3 Parquet)

---

## Development

```bash
pnpm install                # or npm install
pnpm db:generate            # generate Prisma client
pnpm db:migrate             # run migrations
pnpm dev                    # tsx watch
pnpm test                   # vitest
pnpm openapi:lint           # validate OpenAPI spec
pnpm build                  # tsc → dist/
```

Requires Node ≥ 20.

---

## Contributing

Issues and PRs welcome. Before opening a PR:
- Run `pnpm typecheck && pnpm test && pnpm openapi:lint`.
- Match the existing style (Biome / ESLint settings in repo).
- For new endpoints, update [`openapi/openapi.yaml`](openapi/openapi.yaml) — it's the contract the client repo depends on.

---

## Security

See [SECURITY.md](SECURITY.md) for vulnerability disclosure.

## License

MIT — see [LICENSE](LICENSE).

## Related repos

- [`scorm-engine-client`](https://github.com/scormflow/scorm-engine-client) — TypeScript SDK, iframe player, and React components.
- [`scorm-engine-demo`](https://github.com/scormflow/scorm-engine-demo) — reference LMS built on both repos (planned).
