/**
 * Deno SMTP submission over `Deno.connect`, `Deno.connectTls`, and
 * `Deno.startTls`.
 *
 * @example
 * ```ts
 * import { DenoMailer } from "@sparticle9/edge-mailer/deno";
 * ```
 *
 * @module deno
 */
export * from './email.ts'
export * from './dkim.ts'
export * from './icalendar.ts'
export * from './observation.ts'
export * from './runtime/deno.ts'
export * from './smtp/mailer.ts'
export * from './smtp/pool.ts'
export { LogLevel } from './logger.ts'
