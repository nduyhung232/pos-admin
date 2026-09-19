/**
 * Configuration, loaded from the environment.
 *
 * Merged build: this is the single Express app (admin UI + sync API), so it does
 * not fail hard the way the production Fastify backend did — it ships sensible
 * local defaults so `npm start` works out of the box like sales_web, while still
 * warning when a weak secret is used outside development.
 */

export interface Config {
  port: number;
  host: string;
  /** Signing/secret key for admin session cookies. */
  sessionSecret: string;
  /** Session lifetime in ms. */
  sessionTtlMs: number;
  isProduction: boolean;
}

export function loadConfig(): Config {
  const isProduction = process.env.NODE_ENV === 'production';

  // Local-friendly default so the merged app runs with zero setup (like
  // sales_web). In production a real secret MUST be provided via env.
  let sessionSecret = process.env.SESSION_SECRET ?? '';
  if (sessionSecret.trim() === '') {
    if (isProduction) {
      throw new Error('SESSION_SECRET is required in production (min 32 chars).');
    }
    sessionSecret = 'pos-admin-web-local-dev-secret-change-me-please';
  }
  if (isProduction && sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters in production');
  }

  return {
    port: Number(process.env.PORT ?? 3100),
    host: process.env.HOST ?? '0.0.0.0',
    sessionSecret,
    sessionTtlMs: Number(process.env.SESSION_TTL_MS ?? 8 * 60 * 60 * 1000),
    isProduction,
  };
}
