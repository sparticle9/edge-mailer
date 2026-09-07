/**
 * Backwards-compatible Cloudflare mailer entrypoint.
 *
 * Prefer `edge-mailer/cloudflare` for new Cloudflare Workers code.
 *
 * @module mailer
 */
export * from './runtime/cloudflare.ts'
export * from './smtp/mailer.ts'
