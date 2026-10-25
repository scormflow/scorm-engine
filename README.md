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

The engine is now live on `http://localhost:3000`. Liveness: `GET /healthz`. Readiness (database + storage reachable, `503` otherwise): `GET /readyz`. Both are also served inside the API as `/api/v1/health` and `/api/v1/ready`.

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
POST   /api/v1/courses                        Upload + register a SCORM package
POST   /api/v1/courses/validate               Validate a package without registering
GET    /api/v1/courses                        List courses for the tenant
GET    /api/v1/courses/:id                    Course metadata + SCO tree
GET    /api/v1/courses/:id/content/*          Stream an extracted package file

POST   /api/v1/courses/:id/attempts           Start or resume a learner attempt
GET    /api/v1/attempts/:id                   Attempt state (objectives, interactions)
GET    /api/v1/attempts/:id/runtime           Rehydrate CMI for a (re)launched SCO
POST   /api/v1/attempts/:id/commit            Batched SetValue commit (+ terminate; optional idempotent `seq`)
POST   /api/v1/attempts/:id/sync              Replay an offline commit queue (applied / duplicate / conflict)

POST   /api/v1/auth/attempt-token             Mint a short-lived, attempt-scoped JWT
GET    /api/v1/runtime.js                     Drop-in SCORM 1.2 / 2004 browser bridge
GET    /api/v1/play/:attemptId                Hydrated iframe player page

GET    /api/v1/analytics/overview
GET    /api/v1/analytics/courses/:id
GET    /api/v1/analytics/learners/:id

GET    /api/v1/xapi/about                     LRS version discovery (unauthenticated)
POST   /api/v1/xapi/statements                Store one statement or a batch
PUT    /api/v1/xapi/statements?statementId=   Store a statement under a known id
GET    /api/v1/xapi/statements                Query statements (filters + paging)
GET    /api/v1/xapi/activities/state          Fetch a state doc, or list state ids
PUT    /api/v1/xapi/activities/state          Replace a state document
POST   /api/v1/xapi/activities/state          Merge into a state document
DELETE /api/v1/xapi/activities/state          Delete one or all state documents
GET    /api/v1/xapi/activities/profile        Fetch an activity profile, or list ids
PUT    /api/v1/xapi/activities/profile        Replace an activity profile document
POST   /api/v1/xapi/activities/profile        Merge into an activity profile document
DELETE /api/v1/xapi/activities/profile        Delete an activity profile document
GET    /api/v1/xapi/agents/profile            Fetch an agent profile, or list ids
PUT    /api/v1/xapi/agents/profile            Replace an agent profile document
POST   /api/v1/xapi/agents/profile            Merge into an agent profile document
DELETE /api/v1/xapi/agents/profile            Delete an agent profile document
GET    /api/v1/xapi/activities                Canonical Activity for an IRI
GET    /api/v1/xapi/agents                    Person view of one agent

POST   /api/v1/cmi5/courses                   Import a cmi5 course (ZIP or bare cmi5.xml)
POST   /api/v1/cmi5/courses/validate          Validate a course structure without importing
GET    /api/v1/cmi5/courses                   List cmi5 courses
GET    /api/v1/cmi5/courses/:id               Course, AUs, and block structure
DELETE /api/v1/cmi5/courses/:id               Delete a course and its registrations
POST   /api/v1/cmi5/registrations             Register a learner (actor or learnerId)
GET    /api/v1/cmi5/registrations/:id         Per-AU progress + course satisfaction
POST   /api/v1/cmi5/registrations/:id/launch  Launch an AU → launch URL
POST   /api/v1/cmi5/registrations/:id/waive   Waive an AU's moveOn requirement
GET    /api/v1/cmi5/learner-preferences       Read a learner's cmi5LearnerPreferences
PUT    /api/v1/cmi5/learner-preferences       Set language / audio preferences
POST   /api/v1/cmi5/fetch                     One-time fetch URL → LRS auth token (AU-facing)
GET    /api/v1/cmi5/content/:token/*          Engine-hosted AU files (AU-facing)

POST   /api/v1/webhooks                       Register an endpoint (returns its secret)
GET    /api/v1/webhooks                       List endpoints
GET    /api/v1/webhooks/event-types           Event types you can subscribe to
PATCH  /api/v1/webhooks/:id                   Change url / events / enabled
DELETE /api/v1/webhooks/:id                   Delete an endpoint and its delivery log
POST   /api/v1/webhooks/:id/rotate-secret     Replace the signing secret
POST   /api/v1/webhooks/:id/test              Send a signed webhook.test event
GET    /api/v1/webhooks/:id/deliveries        Delivery log (filter by status / event)
POST   /api/v1/webhooks/deliveries/:id/retry  Re-send a delivery, incl. dead-lettered ones

GET    /api/v1/events/stream                  Live engine events over SSE (`?types=` to filter)

GET    /api/v1/plugins                        Installed plugins
GET    /api/v1/plugins/analytics/activity     Live per-minute event counts (analytics plugin)

GET    /api/v1/certificates                   List certificates (filter by learner / course / status)
GET    /api/v1/certificates/:id               One certificate
GET    /api/v1/certificates/:id/pdf           The certificate PDF (`?download=1` to save)
POST   /api/v1/certificates/:id/revoke        Revoke (verification then reports it invalid)
GET    /api/v1/certificates/verify/:serial    Public check of a printed certificate code
GET    /api/v1/attempts/:id/certificate       The attempt's certificate (attempt token OK)
GET    /api/v1/attempts/:id/certificate/pdf   Its PDF (attempt token via header or `?token=`)
POST   /api/v1/attempts/:id/certificate       Issue now (idempotent; 409 if not eligible)

GET    /api/v1/ai/providers                   AI provider configs (keys never returned)
PUT    /api/v1/ai/providers/:feature          Set provider/model/key for default|insights|summary|recommendations
DELETE /api/v1/ai/providers/:feature          Remove a config
POST   /api/v1/ai/providers/test              Check a provider + key without storing it
POST   /api/v1/ai/insights                    Insights / summary / recommendations (course or tenant)
GET    /api/v1/ai/usage                       This month's tokens, cost and cap status per config
GET    /api/v1/ai/calls                       AI call audit log (`?format=csv` to export)
```

Auth: `X-API-Key: <api-key>` for tenant calls (the LRS included); a short-lived,
attempt-scoped JWT for the browser player's runtime calls. Every LRS request
except `/xapi/about` must also send `X-Experience-API-Version: 1.0.3`.

### xAPI attachments

Send statements with attachment bodies as `multipart/mixed`: the statement JSON
first, then one part per body with `Content-Transfer-Encoding: binary` and
`X-Experience-API-Hash: <sha2>`. The LRS checks each body against its hash and
against the statements' `attachments` list (bodies may be omitted only for
attachments that carry a `fileUrl`), then stores it content-addressed under
`tenants/<id>/xapi-attachments/`. `GET /xapi/statements?attachments=true`
returns the same `multipart/mixed` shape. Signature attachments (JWS
RS256/384/512) must sign the statement they are attached to and are verified
when they embed an `x5c` certificate.

### Suspend and resume

When SCORM content sets `cmi.exit` (`cmi.core.exit` in 1.2) to `suspend` and
then terminates, the commit returns `suspended: true` and the attempt stays
`IN_PROGRESS`: the session time is banked as `total_time`, and the next
`POST /courses/:id/attempts` for that learner resumes the same attempt with
`entry: "resume"` and its location and `suspend_data` intact. Any other exit
finalizes the attempt, and the next start opens a new one. The `/play` page
seeds `entry` and the learner id / name, so content can tell a resume from a
first launch.

### cmi5

The engine plays the cmi5 LMS role end to end. `launch` abandons any session the
learner left open on that AU, opens a new one, writes `LMS.LaunchData`, records
`launched`, and returns the AU URL with `endpoint`, `fetch`, `actor`,
`registration` and `activityId` attached. The AU redeems the fetch URL once for
an auth token and sends it to the built-in LRS as `Authorization: Basic …`.

Statements sent under that token are checked against the cmi5 statement rules
before they are stored — `initialized` first, nothing after `terminated`, no
LMS-only verbs, matching actor / registration / session id, the cmi5 and moveon
categories, `completed` / `passed` once per registration, masteryScore checks,
no moveOn verbs in Browse / Review mode — and a violation is a `403`. A token
also only reaches its own learner and registration. When every AU in a block
meets its moveOn criterion the engine records `satisfied` for that block, and
when every AU in the course does, for the course.

Learner preferences (`languagePreference`, `audioPreference`) are stored as the
`cmi5LearnerPreferences` Agent Profile document, where AUs read them through the
LRS. Set them with `PUT /cmi5/learner-preferences`, or pass
`learnerPreferences` when creating a registration.

Session tokens and hosted-content links live for `JWT_ATTEMPT_TTL_SECONDS`.

### Webhooks

Register an endpoint with the events it wants (or `*`):

```bash
curl -X POST $ENGINE/api/v1/webhooks -H "X-API-Key: $KEY" -H "content-type: application/json" \
  -d '{"url":"https://example.com/hooks/scormflow","events":["course.completed","cmi5.course.satisfied"]}'
```

Events: `attempt.started`, `attempt.suspended`, `attempt.terminated`, `course.completed`,
`course.passed`, `course.failed`, `score.updated` (SCORM attempts — each fires on
the transition, not on every commit); `objective.mastered` (a SCORM objective's
success status first becomes `passed`, matched by objective id);
`certificate.issued`, `certificate.revoked`; `cmi5.session.terminated`, `cmi5.session.abandoned`, `cmi5.au.waived`,
`cmi5.block.satisfied`, `cmi5.course.satisfied`; `xapi.statement.stored` (once
per newly stored LRS statement — including cmi5 and LMS-issued ones, never for a
duplicate resend; `data.statement` is the stored statement); and `webhook.test`.

Each delivery is a JSON `POST` of `{ id, type, createdAt, data }` with
`ScormFlow-Signature: t=<unix>,v1=<hex>` — HMAC-SHA256 over `"<t>.<raw body>"`
with the endpoint secret. Verify it against the raw body before trusting the
event (`verifySignature` here, or `verifyWebhookSignature` in `@scormflow/sdk`).
A 2xx acknowledges it. Anything else — including redirects and timeouts — is
retried with exponential backoff (`WEBHOOK_RETRY_BASE_SECONDS` × 2ⁿ, capped at 6 h)
until `WEBHOOK_MAX_ATTEMPTS`, then the delivery is parked as `FAILED` (the
dead-letter state) and can be re-sent from the delivery log. Delivery is
at-least-once: dedupe on the event `id`.

Retries are picked up by an in-process poller (`WEBHOOK_WORKER_INTERVAL_MS`) that
the server entrypoint starts; when embedding, pass `startWebhookWorker: true` to
`buildApp`. Deliveries are claimed with a lease, so several engine instances can
share one database. Endpoint URLs on localhost / private / link-local addresses
are refused unless `WEBHOOK_ALLOW_PRIVATE_URLS=true`; this check does not resolve
DNS, so pair it with egress filtering if tenants are untrusted.

### Event bus and live events

Services never call webhooks (or anything else) directly: they publish to the
engine's event bus, which stamps each event with an id and timestamp and hands
it to two kinds of receivers. **Subscribers** do work — the webhook dispatcher
is one — and each event reaches one engine instance. **Listeners** observe —
the live stream below is one — and run on every instance.

`EVENT_BUS_DRIVER=memory` (the default) keeps events in-process.
`EVENT_BUS_DRIVER=redis` (with `REDIS_URL`, Redis 6.2+) carries them over a Redis
stream: subscribers read through a consumer group, so a cluster sends each
webhook once; an event whose subscriber fails stays pending, is retried once it
has been idle for a minute, and after five deliveries is copied to
`<stream>:dead`. The Redis client is built in (RESP over `node:net`/`node:tls`),
so there is no extra dependency. Embedders can attach their own subscribers:

```ts
const app = await buildApp({ env });
app.events.subscribe('crm-sync', async (event) => {
  if (event.type === 'course.completed') await crm.markComplete(event.data.attemptId);
}); // idempotent on event.id — redelivery is possible with Redis
```

`GET /api/v1/events/stream` (API key) is a Server-Sent Events feed of the
tenant's events, each message carrying the same `{ id, type, createdAt, data }`
a webhook receives — handy for dashboards that don't want a public endpoint.
Filter with `?types=course.completed,certificate.issued`. Events are not
replayed after a reconnect (webhooks are the durable channel); idle streams get
a `: ping` comment every `EVENT_STREAM_HEARTBEAT_SECONDS`.

```bash
curl -N $ENGINE/api/v1/events/stream -H "X-API-Key: $KEY"
```

### Plugins

A plugin bundles event handlers and API routes behind one name, using only the
context the engine hands it — the bus, database, storage, env and a tagged logger:

```ts
import { analyticsPlugin, buildApp, definePlugin } from '@scormflow/server';

const slack = definePlugin({
  name: 'slack',
  setup(ctx) {
    // Work: once per event across a cluster (bus name `plugin:slack:notify`).
    ctx.subscribe('notify', (e) => postToSlack(`${e.data.learnerId} finished`), { types: ['course.completed'] });
    // Routes: mounted at /api/v1/plugins/slack, API key required, rate limited.
    ctx.routes((r) => r.get('/status', async (req) => ({ tenant: req.tenantId })));
    ctx.onClose(() => slackClient.close());
  },
});

const app = await buildApp({ env, plugins: [analyticsPlugin(), slack] });
```

`ctx.listen` observes events on every instance instead. Plugins are set up in
order while the app is built; a `setup` that throws fails `buildApp`, and names
must be unique and URL-safe. `GET /api/v1/plugins` lists what is installed.

The built-in `analyticsPlugin({ retentionMinutes })` (default 60) counts each
tenant's events per minute; `GET /api/v1/plugins/analytics/activity?minutes=15`
returns totals by type plus a minute-by-minute timeline. Counts are in memory
(every instance counts every event on a Redis bus) and restart from zero with
the process. Docker users without code turn built-ins on with `PLUGINS=analytics`.

### Certificates

The first time an attempt is completed and not failed (SCORM 1.2 `passed` /
`completed`; SCORM 2004 `completion_status=completed` with any `success_status`
but `failed`), the engine issues a certificate for it and emits
`certificate.issued`. Each attempt gets at most one. The learner's name, the
course title and the score (scaled × 100, else raw within min/max) are
snapshotted at issue time, and the PDF — one landscape A4 page in the
standard Helvetica fonts, with no PDF library involved — is rendered on demand
from them. Issuing never fails a commit; if it errors, the error is logged and
`POST /attempts/:id/certificate` issues it later (the same call backfills
attempts that finished before certificates were turned on).

Every certificate prints a serial like `7KQ2-M9XD-4TPA`. `GET
/certificates/verify/:serial` needs no credentials and returns only what is
printed, plus whether it has been revoked; set `CERTIFICATE_VERIFY_BASE_URL` to
your own verification page to have its link (`<base>/<serial>`) printed too.
A learner-facing page can fetch `/attempts/:id/certificate[/pdf]` with the
attempt's player token. Turn the feature off with `CERTIFICATES_ENABLED=false`.

### AI analytics (bring your own AI)

Set `AI_MASTER_KEY` and each tenant can plug in its own model — OpenAI,
Anthropic, Gemini, Mistral, a local Ollama, or any OpenAI-compatible endpoint.
The engine never bundles or proxies a default model.

```bash
curl -X PUT $ENGINE/api/v1/ai/providers/default -H "X-API-Key: $KEY" \
  -H 'content-type: application/json' \
  -d '{"provider":"anthropic","model":"claude-sonnet-5-5","apiKey":"sk-ant-…","monthlyTokenCap":2000000}'

curl -X POST $ENGINE/api/v1/ai/insights -H "X-API-Key: $KEY" \
  -H 'content-type: application/json' -d '{"kind":"insights","courseId":"<id>"}'
```

- **Grounded in aggregates, not people.** The model sees outcome rates, where
  unfinished attempts stopped (`lesson_location`), the most-failed objectives
  and most-missed questions (with common wrong answers) over the latest 500
  attempts — never learner ids, names or attempt ids.
- **PII redaction.** Emails, card numbers, SSNs, IPs and phone numbers in the
  prompt (course text, typed answers, your question) become `[EMAIL]` etc.
  before it leaves. Turn it off per config (`redactPii: false`) for local models.
- **Keys encrypted at rest.** Envelope encryption: a random AES-256-GCM data
  key per stored key, wrapped by a per-tenant key derived from `AI_MASTER_KEY`.
  Keys are write-only; responses show only `keyHint`. `POST /ai/providers/test`
  checks a key without storing it.
- **Per-feature scoping.** Configs for `insights`, `summary` and
  `recommendations` override `default`, each with its own key and budget.
- **Cost controls.** A monthly token cap per config (429 `ai_budget_exceeded`
  once spent), `ai.budget.alert` at `alertThreshold` and at the cap, and an
  `enabled` kill-switch. Give `inputCostPerMTok` / `outputCostPerMTok` to get
  USD costs.
- **Audit.** Every call — succeeded, failed or blocked — is logged with the
  prompt's SHA-256, provider, model, tokens and cost (`GET /ai/calls`, CSV export).

Provider URLs on private networks (a local Ollama) need `AI_ALLOW_PRIVATE_URLS=true`.

### Session replay

`GET /attempts/:id/replay` reconstructs what a learner did — *launched →
slide 2 → answered q1 wrong → tab hidden 4 min → suspended → resumed → passed*
— as an ordered timeline. Nothing extra needs recording for the basic version:
every commit's CMI state is already in the commit log, and diffing consecutive
commits recovers location, status, score, progress, interaction, objective and
suspend / resume changes.

For what happens *between* commits, a player can opt in to capture and post
batches to `POST /attempts/:id/replay/events` with its attempt token:
`page.hidden` / `page.visible`, `idle.start` / `idle.end`, `navigation`,
`pointer` (x / y relative to the content frame), `media.play|pause|ended`, or
any content-defined name such as `quiz.skipped`. Events carry a client id, so
a retried batch is stored once.

- **Visits.** Per-location enter / leave times and *active* seconds — suspended
  stretches, hidden tabs, idle time and silences over 30 minutes don't count.
- **Engagement score.** 0–100 from progress (0.4), focus — share of open time
  the tab was visible and not idle (0.3), and interactivity — interactions per
  active minute (0.3). Components without data are left out and the rest
  reweighted, so a course without capture is scored on what is known.
- **Course heatmap.** `GET /courses/:id/heatmap` folds the latest attempts
  (default 50, at most 200) into per-location reach, dwell, interactions,
  drop-offs (where unfinished attempts stopped) and a 10 × 10 pointer grid.

Timelines are rebuilt on read; nothing is precomputed. Turn capture off with
`REPLAY_CAPTURE_ENABLED=false`.
The cap is checked before each call, so concurrent calls can overshoot it slightly.

---

## Architecture

```
src/
├── parser/       imsmanifest.xml + ZIP extraction              [done]
├── runtime/      SCORM 1.2 + 2004 CMI model + session          [done]
├── tracking/     Attempt + progress persistence                [done]
├── xapi/         Built-in LRS (statements, documents, lookups) [done]
├── cmi5/         cmi5 course structure, launch, statement rules [done]
├── events/       Event bus: memory + Redis Streams transports  [done]
├── webhooks/     Endpoints, signing, delivery + retry worker   [done]
├── certificates/ Completion certificates + PDF writer          [done]
├── plugins/      Plugin host + built-in analytics plugin       [done]
├── ai/           BYO-AI insights, key vault, PII redaction     [done]
├── storage/      Storage adapters: local disk, S3 / R2 / MinIO [done]
├── analytics/    Analytics + reporting                         [done]
├── http/         Fastify routes + runtime bridge               [done]
├── auth/         API keys + attempt JWTs                       [done]
├── services/     Course / attempt / runtime services           [done]
├── db/           Prisma client                                 [done]
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
| `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Required for the `s3` driver (`S3_REGION=auto` for R2) |
| `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE` | Point the `s3` driver at R2 / MinIO / another S3-compatible store; MinIO needs path style |
| `S3_SESSION_TOKEN` | Only for temporary (STS) credentials |
| `STORAGE_PREFIX` | Optional namespace for every stored key (tenant files sit under `tenants/<id>/` beneath it) |
| `RATE_LIMIT_MAX` | Authenticated requests each tenant may make per window; `0` disables (default 0) |
| `RATE_LIMIT_WINDOW_SECONDS` | Rate-limit window length (default 60) |
| `JWT_SECRET` | Signing secret for runtime tokens |
| `JWT_ATTEMPT_TTL_SECONDS` | Lifetime of an attempt-scoped player token |
| `SCORM_VALIDATION_MODE` | `lenient` (default) or `strict` CMI write validation |
| `XAPI_AUTHORITY_HOMEPAGE` | Home page of the `authority` the LRS stamps on statements |
| `XAPI_REQUIRE_PRECONDITIONS` | Require `If-Match` / `If-None-Match` on State API writes |
| `WEBHOOK_MAX_ATTEMPTS` | Attempts before a delivery is dead-lettered (default 8) |
| `WEBHOOK_RETRY_BASE_SECONDS` | First retry delay; doubles each attempt, capped at 6 h (default 30) |
| `WEBHOOK_TIMEOUT_MS` | Per-attempt request timeout (default 10000) |
| `WEBHOOK_WORKER_INTERVAL_MS` | Retry poll interval; `0` disables the poller (default 5000) |
| `WEBHOOK_ALLOW_PRIVATE_URLS` | Allow endpoints on localhost / private networks (default false) |
| `EVENT_BUS_DRIVER` | `memory` (default) or `redis` — needed once several engine instances share a database |
| `REDIS_URL` | `redis://[user:pass@]host:port[/db]` or `rediss://…`; required for the `redis` event bus |
| `EVENT_BUS_STREAM`, `EVENT_BUS_GROUP` | Redis stream key and consumer group (default `scormflow:events` / `scormflow`) |
| `EVENT_BUS_MAX_LENGTH` | Approximate cap on the Redis stream (default 100000) |
| `EVENT_STREAM_HEARTBEAT_SECONDS` | Keep-alive interval on `/events/stream` (default 15) |
| `PLUGINS` | Built-in plugins to install, comma-separated (`analytics`); ignored when `buildApp` gets a `plugins` list |
| `CERTIFICATES_ENABLED` | Issue PDF certificates on completion (default true) |
| `CERTIFICATE_ISSUER` | Organization printed as the issuer (default `ScormFlow`) |
| `CERTIFICATE_VERIFY_BASE_URL` | Public verification page; `<base>/<serial>` is printed on each certificate |
| `CERTIFICATE_ACCENT_COLOR` | `#rrggbb` for the certificate frame and heading (default `#1f4e79`) |
| `AI_MASTER_KEY` | 32-byte key (hex or base64) that encrypts tenants' AI provider keys; unset turns `/ai` off |
| `AI_ALLOW_PRIVATE_URLS` | Allow AI provider URLs on localhost / private networks, e.g. Ollama (default false) |
| `AI_TIMEOUT_MS` | Per-call timeout for AI providers (default 60000) |
| `AI_MAX_OUTPUT_TOKENS` | Longest answer requested from a model (default 1024) |
| `REPLAY_CAPTURE_ENABLED` | Accept players' session-replay capture events (default true); commit-based timelines work either way |
| `REPLAY_MAX_EVENTS_PER_ATTEMPT` | Capture events stored per attempt; later ones are dropped (default 5000) |

---

## Roadmap

Checkboxes reflect the actual state of `main`.

### Phase 1 — MVP (foundation)
- [x] Repo init, TypeScript strict mode, Fastify app skeleton
- [x] Prisma schema (Tenant, ApiKey, Course, Sco, Learner, Attempt, Interaction, Objective, CommitLog; xAPI, cmi5 + webhook tables)
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
- [x] S3 / R2 / MinIO storage driver (dependency-free SigV4, multipart uploads)
- [x] Readiness probe that checks the database and storage
- [x] JWT issuance for runtime / player tokens (`POST /auth/attempt-token`)
- [x] Attempt lifecycle routes (start/resume, read-back, terminate-on-commit)
- [x] CMI data model + value validation (SCORM 1.2)
- [x] CMI data model + value validation (SCORM 2004)
- [x] Runtime API routes (batched commit + runtime rehydration)
- [x] Resume support (suspend_data, lesson_location persistence; exit=suspend keeps the attempt open across sessions)
- [x] Basic analytics endpoints (course / learner / overview)
- [x] Standalone iframe player route (`GET /play/:attemptId`)
- [x] Drop-in runtime bridge (`GET /runtime.js`)
- [x] Multi-tenant rate limiting + isolated storage prefixes
- [x] End-to-end test: upload → launch → track → resume → complete

### Phase 2 — Strong differentiators
- [x] xAPI 1.0.3 Statement API (store, query, void, paging)
- [x] xAPI 1.0.3 State API (documents, merge, ETag preconditions)
- [x] xAPI 1.0.3 Activity Profile + Agent Profile APIs
- [x] xAPI 1.0.3 Activity + Agent (Person) lookups
- [x] xAPI attachments (multipart statement upload, `attachments=true` retrieval, JWS signature checks)
- [x] Built-in LRS, tenant-scoped and queryable
- [x] cmi5 course structure import (`cmi5.xml`, ZIP or structure-only)
- [x] cmi5 launch + registration management (LaunchData, one-time fetch URL, session tokens)
- [x] cmi5 session lifecycle (initialized → completed / passed / failed / terminated / abandoned)
- [x] cmi5 statement rules enforced by the LRS; moveOn evaluation, waive, course `satisfied`
- [x] cmi5 block-level `satisfied` statements and `cmi5LearnerPreferences` agent profile
- [x] Webhook system (signed payloads, retries, dead-letter, delivery log)
- [x] Webhook events for xAPI statements and SCORM objectives (`objective.mastered`)
- [x] Offline sync queue + reconciliation (`POST /attempts/:id/sync`, idempotent `seq` replay, conflict reporting)
- [x] Certificate engine (PDF generation on completion, public verification, revocation)
- [x] Event bus (in-process or Redis Streams; consumer-group work delivery, retries, dead-letter stream)
- [x] Live event stream (`GET /events/stream`, Server-Sent Events)
- [x] Plugin system (`plugins: [analyticsPlugin(), …]`, routes under `/plugins/:name`, `PLUGINS` env for built-ins)
- [ ] `certificatePlugin()` — certificates are still built in, toggled by `CERTIFICATES_ENABLED`

### Phase 3 — Category-defining
- [x] AI analytics layer with BYO provider + key (OpenAI / Anthropic / Gemini / Mistral / Ollama / OpenAI-compatible)
- [x] PII redaction pass for AI prompts
- [x] AI key encryption at rest, per-feature configs, monthly token caps + alerts, kill-switch, call audit log
- [ ] AI providers, phase 2: Azure OpenAI, AWS Bedrock (Groq / Together work today as `openai_compatible`)
- [x] Session replay (event timeline from commits + opt-in capture, course heatmaps, engagement scoring)
- [ ] Git-style course versioning (releases, diffs, rollback)
- [ ] Universal Learning Content Gateway (SCORM / xAPI / cmi5 / H5P / HTML / video / PDF)
- [ ] Compliance dashboards (audit log, attestation, certification expiry)
- [ ] Learning data warehouse export (BigQuery / Snowflake / Redshift / S3 Parquet)

---

## Development

```bash
pnpm install                # or npm install
pnpm db:push                # sync prisma/schema.prisma to DATABASE_URL (+ regenerate client)
pnpm dev                    # tsx watch
pnpm test                   # vitest
pnpm openapi:lint           # validate OpenAPI spec
pnpm build                  # tsc → dist/
```

Requires Node ≥ 20.

### Database schema

The engine is not deployed anywhere yet, so there are no migration files:
`prisma/schema.prisma` is the source of truth and every schema change (such as
the `Certificate` table) reaches your database with:

```bash
npm run db:push             # = prisma db push: create/alter tables to match the schema, regenerate the client
```

`db push` may drop data when a change is destructive (it asks first), so it is
for development databases only. Before the first real deployment, switch to
migrations once:

```bash
npm run db:migrate:init     # = prisma migrate dev --name init: writes prisma/migrations/<ts>_init
npm run db:migrate          # later schema changes: prisma migrate dev --name <change>
npm run db:migrate:deploy   # on the server / in CI: apply pending migrations
```

Commit `prisma/migrations/` from then on; it ships in the npm package and CI
already runs `prisma migrate deploy` against it.

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
