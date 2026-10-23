import { afterEach, describe, expect, it } from 'vitest';
import { loadEnv, resetEnvForTests } from '../../src/config/env.js';

const baseEnv = {
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test?schema=public',
  JWT_SECRET: 'this-is-a-test-jwt-secret-thirty-two-chars',
};

afterEach(() => {
  resetEnvForTests();
});

describe('loadEnv', () => {
  it('parses a minimal valid environment and applies defaults', () => {
    const env = loadEnv(baseEnv);
    expect(env.NODE_ENV).toBe('development');
    expect(env.HOST).toBe('0.0.0.0');
    expect(env.PORT).toBe(3000);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.STORAGE_DRIVER).toBe('local');
    expect(env.STORAGE_LOCAL_DIR).toBe('./.storage');
    expect(env.JWT_ATTEMPT_TTL_SECONDS).toBe(3600);
    expect(env.S3_FORCE_PATH_STYLE).toBe(false);
  });

  it('coerces PORT and JWT_ATTEMPT_TTL_SECONDS from strings to numbers', () => {
    const env = loadEnv({
      ...baseEnv,
      PORT: '8080',
      JWT_ATTEMPT_TTL_SECONDS: '900',
    });
    expect(env.PORT).toBe(8080);
    expect(env.JWT_ATTEMPT_TTL_SECONDS).toBe(900);
  });

  it('reads boolean flags the way people spell them in a .env', () => {
    expect(loadEnv({ ...baseEnv, XAPI_REQUIRE_PRECONDITIONS: 'false' }).XAPI_REQUIRE_PRECONDITIONS)
      .toBe(false);
    resetEnvForTests();
    expect(loadEnv({ ...baseEnv, XAPI_REQUIRE_PRECONDITIONS: 'TRUE' }).XAPI_REQUIRE_PRECONDITIONS)
      .toBe(true);
    resetEnvForTests();
    expect(loadEnv({ ...baseEnv, S3_FORCE_PATH_STYLE: 'no' }).S3_FORCE_PATH_STYLE).toBe(false);
  });

  it('defaults the LRS authority home page', () => {
    expect(loadEnv(baseEnv).XAPI_AUTHORITY_HOMEPAGE).toBe('https://scormflow.dev/lrs');
  });

  it('defaults certificates on and treats blank optional settings as unset', () => {
    const env = loadEnv({ ...baseEnv, CERTIFICATE_VERIFY_BASE_URL: '', CERTIFICATE_ACCENT_COLOR: ' ' });
    expect(env.CERTIFICATES_ENABLED).toBe(true);
    expect(env.CERTIFICATE_ISSUER).toBe('ScormFlow');
    expect(env.CERTIFICATE_VERIFY_BASE_URL).toBeUndefined();
    expect(env.CERTIFICATE_ACCENT_COLOR).toBeUndefined();
  });

  it('rejects a malformed CERTIFICATE_ACCENT_COLOR', () => {
    expect(() => loadEnv({ ...baseEnv, CERTIFICATE_ACCENT_COLOR: 'navy' })).toThrow(/CERTIFICATE_ACCENT_COLOR/);
  });

  it('defaults the event bus to memory and requires REDIS_URL for the redis driver', () => {
    const env = loadEnv({ ...baseEnv, REDIS_URL: '' });
    expect(env.EVENT_BUS_DRIVER).toBe('memory');
    expect(env.EVENT_BUS_STREAM).toBe('scormflow:events');
    expect(env.EVENT_BUS_GROUP).toBe('scormflow');
    expect(env.EVENT_BUS_MAX_LENGTH).toBe(100_000);
    expect(env.EVENT_STREAM_HEARTBEAT_SECONDS).toBe(15);
    expect(env.REDIS_URL).toBeUndefined();
    resetEnvForTests();
    expect(() => loadEnv({ ...baseEnv, EVENT_BUS_DRIVER: 'redis' })).toThrow(/REDIS_URL is required/);
    resetEnvForTests();
    expect(loadEnv({ ...baseEnv, EVENT_BUS_DRIVER: 'redis', REDIS_URL: 'redis://localhost:6379' }).EVENT_BUS_DRIVER)
      .toBe('redis');
    resetEnvForTests();
    expect(() => loadEnv({ ...baseEnv, EVENT_BUS_DRIVER: 'kafka' })).toThrow(/EVENT_BUS_DRIVER/);
  });

  it('reads PLUGINS as a comma-separated list of built-in plugin names', () => {
    expect(loadEnv(baseEnv).PLUGINS).toEqual([]);
    resetEnvForTests();
    expect(loadEnv({ ...baseEnv, PLUGINS: '' }).PLUGINS).toEqual([]);
    resetEnvForTests();
    expect(loadEnv({ ...baseEnv, PLUGINS: ' analytics , ' }).PLUGINS).toEqual(['analytics']);
    resetEnvForTests();
    expect(() => loadEnv({ ...baseEnv, PLUGINS: 'analytics,nope' })).toThrow(/PLUGINS/);
  });

  it('caches the parsed env across calls', () => {
    const a = loadEnv(baseEnv);
    const b = loadEnv({ ...baseEnv, PORT: '9999' });
    expect(b).toBe(a);
    expect(b.PORT).toBe(3000);
  });

  it('rejects a missing DATABASE_URL', () => {
    expect(() => loadEnv({ JWT_SECRET: baseEnv.JWT_SECRET })).toThrow(/DATABASE_URL/);
  });

  it('rejects a non-URL DATABASE_URL', () => {
    expect(() => loadEnv({ ...baseEnv, DATABASE_URL: 'not-a-url' })).toThrow(/DATABASE_URL/);
  });

  it('rejects a missing JWT_SECRET', () => {
    expect(() => loadEnv({ DATABASE_URL: baseEnv.DATABASE_URL })).toThrow(/JWT_SECRET/);
  });

  it('rejects a JWT_SECRET shorter than 32 characters', () => {
    expect(() => loadEnv({ ...baseEnv, JWT_SECRET: 'too-short' })).toThrow(
      /JWT_SECRET must be at least 32 characters/,
    );
  });

  it('rejects an invalid LOG_LEVEL', () => {
    expect(() => loadEnv({ ...baseEnv, LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
  });

  it('rejects an invalid NODE_ENV', () => {
    expect(() => loadEnv({ ...baseEnv, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('rejects a non-positive PORT', () => {
    expect(() => loadEnv({ ...baseEnv, PORT: '-1' })).toThrow(/PORT/);
  });
});

describe('loadEnv — S3 storage driver', () => {
  it('requires every S3 field when driver is s3', () => {
    try {
      loadEnv({ ...baseEnv, STORAGE_DRIVER: 's3' });
      expect.fail('expected loadEnv to throw');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('S3_REGION');
      expect(msg).toContain('S3_BUCKET');
      expect(msg).toContain('S3_ACCESS_KEY_ID');
      expect(msg).toContain('S3_SECRET_ACCESS_KEY');
    }
  });

  it('accepts a fully configured S3 environment', () => {
    const env = loadEnv({
      ...baseEnv,
      STORAGE_DRIVER: 's3',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'my-bucket',
      S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
      S3_SECRET_ACCESS_KEY: 'shhh',
      S3_FORCE_PATH_STYLE: 'true',
    });
    expect(env.STORAGE_DRIVER).toBe('s3');
    expect(env.S3_REGION).toBe('us-east-1');
    expect(env.S3_BUCKET).toBe('my-bucket');
    expect(env.S3_FORCE_PATH_STYLE).toBe(true);
  });

  it('does not require S3 fields when driver is local', () => {
    expect(() => loadEnv({ ...baseEnv, STORAGE_DRIVER: 'local' })).not.toThrow();
  });

  it('treats blank S3 values (as .env.example ships them) as unset', () => {
    const blank = {
      S3_ENDPOINT: '',
      S3_REGION: '',
      S3_BUCKET: '',
      S3_ACCESS_KEY_ID: '',
      S3_SECRET_ACCESS_KEY: '',
      S3_SESSION_TOKEN: '',
    };
    const env = loadEnv({ ...baseEnv, STORAGE_DRIVER: 'local', ...blank });
    expect(env.S3_ENDPOINT).toBeUndefined();
    resetEnvForTests();
    expect(() => loadEnv({ ...baseEnv, STORAGE_DRIVER: 's3', ...blank })).toThrow(/S3_BUCKET is required/);
  });
});

describe('resetEnvForTests', () => {
  it('clears the cache so the next loadEnv re-validates the source', () => {
    const first = loadEnv(baseEnv);
    resetEnvForTests();
    const second = loadEnv({ ...baseEnv, PORT: '9999' });
    expect(second).not.toBe(first);
    expect(second.PORT).toBe(9999);
  });
});
