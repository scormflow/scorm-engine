import { z } from 'zod';

const StorageDriver = z.enum(['local', 's3']);

/**
 * Env vars arrive as strings, and `z.coerce.boolean()` would read the string
 * "false" as `true`. Accept the spellings people actually write in a `.env`.
 */
const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase())));

/** Treat `FOO=` (as `.env.example` ships it) the same as leaving FOO unset. */
function emptyAsUndefined<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema);
}

const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().url(),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_ATTEMPT_TTL_SECONDS: z.coerce.number().int().positive().default(3600),

  // How the runtime treats CMI writes that fail validation.
  //  - lenient (default): mirror certified LMSes — accept the value, surface a
  //    warning. Keeps real-world non-compliant content working.
  //  - strict: reject the write and report an error. Useful for conformance
  //    testing SCORM content against the spec.
  SCORM_VALIDATION_MODE: z.enum(['lenient', 'strict']).default('lenient'),

  // Identifies this LRS in the `authority` the built-in LRS stamps onto every
  // statement it stores: an Agent account on this home page, named for the tenant.
  XAPI_AUTHORITY_HOMEPAGE: z.string().url().default('https://scormflow.dev/lrs'),
  // When true, State API writes against an existing document must carry If-Match
  // or If-None-Match (409 otherwise) — the spec's concurrency rule. Off by
  // default so simple clients keep working; turn it on for conformance testing.
  XAPI_REQUIRE_PRECONDITIONS: boolish.default(false),

  // Webhook delivery. Failed deliveries retry with exponential backoff
  // (base × 2^n, capped at 6 h) until WEBHOOK_MAX_ATTEMPTS, then go to the
  // dead-letter state. WEBHOOK_WORKER_INTERVAL_MS=0 turns the retry poller off
  // (first attempts still go out immediately).
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(8),
  WEBHOOK_RETRY_BASE_SECONDS: z.coerce.number().int().positive().default(30),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  WEBHOOK_WORKER_INTERVAL_MS: z.coerce.number().int().min(0).default(5_000),
  // Allow endpoints on localhost / private / link-local addresses. Off by
  // default so a tenant cannot point the engine at internal services.
  WEBHOOK_ALLOW_PRIVATE_URLS: boolish.default(false),

  // Per-tenant API rate limit: at most RATE_LIMIT_MAX authenticated requests per
  // RATE_LIMIT_WINDOW_SECONDS for each tenant, shared by its API keys, attempt
  // tokens and cmi5 sessions. 0 (the default) turns limiting off.
  RATE_LIMIT_MAX: z.coerce.number().int().min(0).default(0),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),

  // Completion certificates. When enabled, an attempt that is completed and not
  // failed gets a PDF certificate automatically. CERTIFICATE_VERIFY_BASE_URL is
  // the public page a reader checks a certificate at; the serial is appended
  // and printed on the PDF (leave empty to print none).
  CERTIFICATES_ENABLED: boolish.default(true),
  CERTIFICATE_ISSUER: z.string().min(1).default('ScormFlow'),
  CERTIFICATE_VERIFY_BASE_URL: emptyAsUndefined(z.string().url().optional()),
  CERTIFICATE_ACCENT_COLOR: emptyAsUndefined(
    z.string().regex(/^#[0-9a-fA-F]{6}$/, 'CERTIFICATE_ACCENT_COLOR must look like #1f4e79').optional(),
  ),

  STORAGE_DRIVER: StorageDriver.default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./.storage'),
  // Namespace for every key the engine writes, so several deployments can share
  // one bucket or directory. Tenant data always lives under `tenants/<id>/`
  // beneath it.
  STORAGE_PREFIX: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z
      .string()
      .regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/, 'STORAGE_PREFIX must be a relative path like "prod/eu-1"')
      .refine((v) => !v.split('/').some((s) => s === '.' || s === '..'), 'STORAGE_PREFIX must not contain "." or ".." segments')
      .optional(),
  ),

  // S3-compatible object storage (AWS S3, Cloudflare R2, MinIO, …), used when
  // STORAGE_DRIVER=s3. Leave S3_ENDPOINT empty for AWS; set it (and usually
  // S3_FORCE_PATH_STYLE=true) for MinIO. R2 takes S3_REGION=auto.
  S3_ENDPOINT: emptyAsUndefined(z.string().url().optional()),
  S3_REGION: emptyAsUndefined(z.string().optional()),
  S3_BUCKET: emptyAsUndefined(z.string().optional()),
  S3_ACCESS_KEY_ID: emptyAsUndefined(z.string().optional()),
  S3_SECRET_ACCESS_KEY: emptyAsUndefined(z.string().optional()),
  // Only for temporary (STS) credentials.
  S3_SESSION_TOKEN: emptyAsUndefined(z.string().optional()),
  S3_FORCE_PATH_STYLE: boolish.default(false),

  REDIS_URL: emptyAsUndefined(z.string().url().optional()),

  // Event bus. `memory` (the default) keeps events inside one process; `redis`
  // carries them over a Redis stream (Redis 6.2+, REDIS_URL required) so a
  // cluster of engine instances sends each webhook once and every instance's
  // live event stream sees every event.
  EVENT_BUS_DRIVER: z.enum(['memory', 'redis']).default('memory'),
  EVENT_BUS_STREAM: z.string().min(1).default('scormflow:events'),
  EVENT_BUS_GROUP: z.string().min(1).default('scormflow'),
  // Approximate cap on the Redis stream's length (older entries are trimmed).
  EVENT_BUS_MAX_LENGTH: z.coerce.number().int().min(1000).default(100_000),
  // Comment line sent on idle `GET /events/stream` connections so proxies keep them open.
  EVENT_STREAM_HEARTBEAT_SECONDS: z.coerce.number().int().positive().default(15),
});

const envSchema = baseSchema.superRefine((env, ctx) => {
  if (env.EVENT_BUS_DRIVER === 'redis' && !env.REDIS_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['REDIS_URL'],
      message: 'REDIS_URL is required when EVENT_BUS_DRIVER=redis',
    });
  }
  if (env.STORAGE_DRIVER === 's3') {
    for (const key of ['S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const) {
      if (!env[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required when STORAGE_DRIVER=s3`,
        });
      }
    }
  }
});

export type Env = z.infer<typeof baseSchema>;

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export function resetEnvForTests(): void {
  cached = undefined;
}
