import { describe, expect, it } from 'vitest'
import denoEntrypointSource from '../../src/deno.ts?raw'
import denoRuntimeSource from '../../src/runtime/deno.ts?raw'
import cloudflareEntrypointSource from '../../src/cloudflare.ts?raw'
import cloudflareRuntimeSource from '../../src/runtime/cloudflare.ts?raw'
import * as cloudflareEntry from '../../src/cloudflare'
import * as denoEntry from '../../src/deno'

describe('runtime entrypoint boundaries', () => {
  it('keeps Cloudflare socket imports out of the Deno entrypoint', () => {
    expect(denoEntrypointSource).not.toContain('cloudflare:sockets')
    expect(denoRuntimeSource).not.toContain('cloudflare:sockets')
    expect(denoEntry).toHaveProperty('DenoMailer')
    expect(denoEntry).not.toHaveProperty('EdgeMailer')
  })

  it('keeps Deno runtime globals out of the Cloudflare entrypoint', () => {
    expect(cloudflareEntrypointSource).not.toMatch(/\bDeno\b/)
    expect(cloudflareRuntimeSource).not.toMatch(/\bDeno\b/)
    expect(cloudflareEntry).toHaveProperty('EdgeMailer')
    expect(cloudflareEntry).not.toHaveProperty('DenoMailer')
  })
})
