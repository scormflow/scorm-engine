import { z } from 'zod';

const StorageDriver = z.enum(['local', 's3']);

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

  STORAGE_DRIVER: StorageDriver.default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./.storage'),

  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(false),

  REDIS_URL: z.string().url().optional(),
});

const envSchema = baseSchema.superRefine((env, ctx) => {
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
