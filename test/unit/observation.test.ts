import { describe, expect, it } from 'vitest'
import {
  classifyMailFailure,
  redactSmtpCommand,
  redactSmtpResponse,
} from '../../src/observation'

describe('observation helpers', () => {
  it('redacts SMTP auth commands, message bodies, and address local parts', () => {
    expect(redactSmtpCommand('AUTH PLAIN AHVzZXIAcGFzcw==\r\n')).toBe(
      'AUTH PLAIN <redacted>',
    )
    expect(redactSmtpCommand('MAIL FROM: <sender@example.com>\r\n')).toBe(
      'MAIL FROM: <***@example.com>',
    )
    expect(redactSmtpCommand('RCPT TO: <recipient@example.net>\r\n')).toBe(
      'RCPT TO: <***@example.net>',
    )
    expect(redactSmtpCommand('Subject: Hi\r\n\r\nsecret body\r\n.\r\n')).toBe(
      '<message body redacted>',
    )
  })

  it('redacts response addresses and inline token-like values', () => {
    expect(
      redactSmtpResponse(
        '550 5.1.1 recipient@example.net rejected token=secret-value\r\n',
      ),
    ).toBe('550 5.1.1 ***@example.net rejected token=<redacted>')
  })

  it('classifies common SMTP failures into retry guidance', () => {
    expect(
      classifyMailFailure({
        stage: 'auth',
        message: 'Failed authentication',
        responseCode: 535,
      }),
    ).toMatchObject({
      reason: 'auth_failed',
      retryHint: 'do_not_retry',
      nextAction: 'check_credentials',
    })

    expect(
      classifyMailFailure({
        stage: 'rcpt',
        message: 'Recipient rejected',
        responseCode: 450,
      }),
    ).toMatchObject({
      reason: 'recipient_rejected',
      retryHint: 'retry',
      nextAction: 'check_recipient',
    })

    expect(
      classifyMailFailure({
        stage: 'mail',
        message: 'SMTPUTF8 is not supported by the SMTP server',
      }),
    ).toMatchObject({
      reason: 'unsupported_extension',
      retryHint: 'do_not_retry',
      nextAction: 'check_server_policy',
    })
  })
})
