import type { Env } from '../../src/config/env.js';

export function createTestEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    HOST: '0.0.0.0',
    PORT: 0,
    LOG_LEVEL: 'fatal',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test?schema=public',
    JWT_SECRET: 'test-jwt-secret-thirty-two-characters-long-enough',
    JWT_ATTEMPT_TTL_SECONDS: 3600,
    SCORM_VALIDATION_MODE: 'lenient',
    STORAGE_DRIVER: 'local',
    STORAGE_LOCAL_DIR: './.storage',
    S3_FORCE_PATH_STYLE: false,
    ...overrides,
  };
}
