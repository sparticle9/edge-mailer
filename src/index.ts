/**
 * Cloudflare-compatible SMTP submission, MIME generation, DKIM signing, and
 * connection pooling primitives.
 *
 * The default entrypoint is intended for Cloudflare Workers and other build
 * pipelines that understand the `cloudflare:sockets` module. Use
 * `@sparticle9/edge-mailer/deno` for Deno CLI or Deno Deploy.
 *
 * @module edge_mailer
 */
export * from './email.ts'
export * from './dkim.ts'
export * from './observation.ts'
export * from './mailer.ts'
export * from './smtp/pool.ts'
export { LogLevel } from './logger.ts'
