import { describe, expect, it } from 'vitest'
import {
  customSmtpProfile,
  googleWorkspaceProfile,
  microsoft365Profile,
  sesSmtpProfile,
  yandexSmtpProfile,
} from '../../src/providers'

describe('provider profiles', () => {
  it('builds Google Workspace XOAUTH2 config without owning OAuth flows', () => {
    const config = googleWorkspaceProfile({
      username: 'sender@example.com',
      accessToken: 'ya29.token',
    })

    expect(config).toMatchObject({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      startTls: true,
      tlsPolicy: 'require-starttls',
      authType: ['xoauth2'],
      credentials: {
        username: 'sender@example.com',
        accessToken: 'ya29.token',
      },
      provider: {
        name: 'google-workspace',
      },
    })
  })

  it('sets provider-specific SMTP defaults', () => {
    expect(microsoft365Profile()).toMatchObject({
      host: 'smtp.office365.com',
      port: 587,
      tlsPolicy: 'require-starttls',
      authType: ['xoauth2', 'login'],
    })
    expect(sesSmtpProfile({ region: 'eu-west-1' })).toMatchObject({
      host: 'email-smtp.eu-west-1.amazonaws.com',
      authType: ['plain', 'login'],
    })
    expect(yandexSmtpProfile()).toMatchObject({
      host: 'smtp.yandex.com',
      port: 465,
      secure: true,
      tlsPolicy: 'require-tls',
    })
  })

  it('allows custom SMTP profiles with explicit TLS policy', () => {
    expect(
      customSmtpProfile({
        host: 'smtp.example.com',
        port: 2525,
        tlsPolicy: 'opportunistic',
      }),
    ).toMatchObject({
      host: 'smtp.example.com',
      port: 2525,
      tlsPolicy: 'opportunistic',
      provider: {
        name: 'custom',
      },
    })
  })
})
