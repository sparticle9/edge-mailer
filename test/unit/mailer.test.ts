import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SMTPError, EdgeMailer } from '../../src/mailer'
import { connect } from 'cloudflare:sockets'

vi.mock('cloudflare:sockets', () => ({
  connect: vi.fn(),
}))

describe('EdgeMailer', () => {
  let mockSocket: any
  let mockReader: any
  let mockWriter: any

  const decodeWrite = (value: Uint8Array) => Buffer.from(value).toString()
  const base64 = (value: string) =>
    Buffer.from(value, 'utf8').toString('base64')
  const writtenLines = () =>
    mockWriter.write.mock.calls.map(([arg]: any[]) => decodeWrite(arg))

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks()

    // Setup mock socket and reader/writer
    mockReader = {
      read: vi.fn(),
      releaseLock: vi.fn(),
    }
    mockWriter = {
      write: vi.fn(),
      releaseLock: vi.fn(),
    }
    mockSocket = {
      readable: { getReader: () => mockReader },
      writable: { getWriter: () => mockWriter },
      opened: Promise.resolve(),
      close: vi.fn(),
      startTls: vi.fn().mockReturnValue({
        readable: { getReader: () => mockReader },
        writable: { getWriter: () => mockWriter },
      }),
    }

    // Setup connect mock
    ;(connect as any).mockReturnValue(mockSocket)
  })

  describe('connection', () => {
    it('should connect to SMTP server successfully', async () => {
      // Mock successful connection sequence
      mockReader.read
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 smtp.example.com ready\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-AUTH PLAIN LOGIN\r\n250 AUTH=PLAIN LOGIN\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('235 Authentication successful\r\n'),
        })

      const mailer = await EdgeMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials: {
          username: 'test@example.com',
          password: 'password',
        },
        authType: ['plain', 'login'],
      })

      expect(connect).toHaveBeenCalledWith(
        {
          hostname: 'smtp.example.com',
          port: 587,
        },
        expect.any(Object),
      )
      expect(mailer).toBeInstanceOf(EdgeMailer)
    })

    it('should connect to SMTP server successfully with STARTTLS', async () => {
      // Mock successful connection sequence with STARTTLS
      mockReader.read
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 smtp.example.com ready\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-STARTTLS\r\n250-AUTH PLAIN LOGIN\r\n250 AUTH=PLAIN LOGIN\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 Ready to start TLS\r\n'),
        })
        // After STARTTLS, server expects another EHLO
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-AUTH PLAIN LOGIN\r\n250 AUTH=PLAIN LOGIN\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('235 Authentication successful\r\n'),
        })

      const mailer = await EdgeMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials: {
          username: 'test@example.com',
          password: 'password',
        },
        authType: ['plain', 'login'],
      })

      expect(connect).toHaveBeenCalledWith(
        {
          hostname: 'smtp.example.com',
          port: 587,
        },
        {
          secureTransport: 'starttls',
          allowHalfOpen: false,
        },
      )
      expect(mailer).toBeInstanceOf(EdgeMailer)
    })

    it('should use fresh reader and writer after STARTTLS', async () => {
      const tlsReader = {
        read: vi.fn(),
        releaseLock: vi.fn(),
      }
      const tlsWriter = {
        write: vi.fn(),
        releaseLock: vi.fn(),
      }
      mockSocket.startTls.mockReturnValue({
        readable: { getReader: () => tlsReader },
        writable: { getWriter: () => tlsWriter },
        close: vi.fn(),
      })

      mockReader.read
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 smtp.example.com ready\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-STARTTLS\r\n250-AUTH PLAIN\r\n250 AUTH=PLAIN\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 Ready to start TLS\r\n'),
        })
      tlsReader.read
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-AUTH PLAIN\r\n250 AUTH=PLAIN\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('235 Authentication successful\r\n'),
        })

      await EdgeMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials: {
          username: 'test@example.com',
          password: 'password',
        },
        authType: ['plain'],
      })

      expect(
        mockWriter.write.mock.calls.map(([arg]: any[]) => decodeWrite(arg)),
      ).toEqual(['EHLO 127.0.0.1\r\n', 'STARTTLS\r\n'])
      expect(
        tlsWriter.write.mock.calls.map(([arg]: any[]) => decodeWrite(arg)),
      ).toEqual(['EHLO 127.0.0.1\r\n', expect.stringContaining('AUTH PLAIN')])
    })

    it('should connect to SMTP server successfully without STARTTLS when secure', async () => {
      // Mock successful connection sequence without STARTTLS
      mockReader.read
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 smtp.example.com ready\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-AUTH PLAIN LOGIN\r\n250 AUTH=PLAIN LOGIN\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('235 Authentication successful\r\n'),
        })

      const mailer = await EdgeMailer.connect({
        host: 'smtp.example.com',
        port: 465,
        secure: true,
        credentials: {
          username: 'test@example.com',
          password: 'password',
        },
        authType: ['plain', 'login'],
      })

      expect(connect).toHaveBeenCalledWith(
        {
          hostname: 'smtp.example.com',
          port: 465,
        },
        {
          secureTransport: 'on',
          allowHalfOpen: false,
        },
      )
      expect(mailer).toBeInstanceOf(EdgeMailer)
    })

    it('should throw error on connection timeout', async () => {
      mockSocket.opened = new Promise(() => {}) // Never resolves

      await expect(
        EdgeMailer.connect({
          host: 'smtp.example.com',
          port: 587,
          socketTimeoutMs: 100,
        }),
      ).rejects.toThrow('Socket timeout!')
    })

    it('should honor responseTimeoutMs for SMTP responses', async () => {
      mockReader.read
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 smtp.example.com ready\r\n'),
        })
        .mockImplementation(() => new Promise(() => {}))

      await expect(
        EdgeMailer.connect({
          host: 'smtp.example.com',
          port: 587,
          responseTimeoutMs: 10,
        }),
      ).rejects.toMatchObject({
        name: 'SMTPError',
        stage: 'ehlo',
        transient: false,
      })
      expect(mockSocket.close).toHaveBeenCalled()
    })

    it('should reject when the SMTP server closes the stream', async () => {
      mockReader.read
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 smtp.example.com ready\r\n'),
        })
        .mockResolvedValueOnce({
          done: true,
        })

      await expect(
        EdgeMailer.connect({
          host: 'smtp.example.com',
          port: 587,
        }),
      ).rejects.toMatchObject({
        name: 'SMTPError',
        stage: 'ehlo',
      })
    })
  })

  describe('server capabilities', () => {
    it('should parse server capabilities correctly', async () => {
      // Mock server response with various capabilities
      mockReader.read
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 smtp.example.com ready\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-STARTTLS\r\n250-AUTH PLAIN LOGIN CRAM-MD5\r\n250 HELP\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 Ready to start TLS\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-AUTH PLAIN LOGIN\r\n250 HELP\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('235 Authentication successful\r\n'),
        })

      const mailer = await EdgeMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials: {
          username: 'test@example.com',
          password: 'password',
        },
        authType: ['plain'],
      })

      expect(mailer).toBeInstanceOf(EdgeMailer)
      // Verify that STARTTLS was initiated due to server capability
      expect(mockSocket.startTls).toHaveBeenCalled()
    })

    it('should handle server without STARTTLS capability', async () => {
      mockReader.read
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 smtp.example.com ready\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-AUTH PLAIN LOGIN\r\n250 HELP\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('235 Authentication successful\r\n'),
        })

      const mailer = await EdgeMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials: {
          username: 'test@example.com',
          password: 'password',
        },
        authType: ['plain'],
      })

      expect(mailer).toBeInstanceOf(EdgeMailer)
      // Verify that STARTTLS was not attempted
      expect(mockSocket.startTls).not.toHaveBeenCalled()
    })
  })

  describe('authentication', () => {
    it('should authenticate with PLAIN auth', async () => {
      mockReader.read
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 smtp.example.com ready\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-AUTH PLAIN LOGIN\r\n250 AUTH=PLAIN LOGIN\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('235 Authentication successful\r\n'),
        })

      await EdgeMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials: {
          username: 'test@example.com',
          password: 'password',
        },
        authType: ['plain'],
      })

      expect(writtenLines()).toEqual([
        'EHLO 127.0.0.1\r\n',
        `AUTH PLAIN ${base64('\u0000test@example.com\u0000password')}\r\n`,
      ])
    })

    it('should authenticate with LOGIN auth', async () => {
      mockReader.read
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 smtp.example.com ready\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-AUTH LOGIN\r\n250 AUTH=LOGIN\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('334 VXNlcm5hbWU6\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('334 UGFzc3dvcmQ6\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('235 Authentication successful\r\n'),
        })

      await EdgeMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials: {
          username: 'test@example.com',
          password: 'password',
        },
        authType: ['login'],
      })

      expect(writtenLines()).toEqual([
        'EHLO 127.0.0.1\r\n',
        'AUTH LOGIN\r\n',
        `${base64('test@example.com')}\r\n`,
        `${base64('password')}\r\n`,
      ])
    })

    it('should authenticate with CRAM-MD5 auth', async () => {
      mockReader.read
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 smtp.example.com ready\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-AUTH CRAM-MD5\r\n250 AUTH=CRAM-MD5\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            `334 ${base64('<12345.67890@smtp.example.com>')}\r\n`,
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('235 Authentication successful\r\n'),
        })

      await EdgeMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials: {
          username: 'test@example.com',
          password: 'password',
        },
        authType: ['cram-md5'],
      })

      expect(writtenLines()).toEqual([
        'EHLO 127.0.0.1\r\n',
        'AUTH CRAM-MD5\r\n',
        'dGVzdEBleGFtcGxlLmNvbSAxZTRhYTU3MzRhYzQyZGU0YTRlNmExMjkwMzQ4YTQxMg==\r\n',
      ])
    })

    it('should default to any supported auth type when credentials are present', async () => {
      mockReader.read
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 smtp.example.com ready\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-AUTH LOGIN\r\n250 AUTH=LOGIN\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('334 VXNlcm5hbWU6\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('334 UGFzc3dvcmQ6\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('235 Authentication successful\r\n'),
        })

      await EdgeMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials: {
          username: 'test@example.com',
          password: 'password',
        },
      })

      expect(writtenLines()).toContain('AUTH LOGIN\r\n')
    })

    it('should throw structured error on PLAIN auth failure', async () => {
      mockReader.read
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 smtp.example.com ready\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-AUTH PLAIN LOGIN\r\n250 AUTH=PLAIN LOGIN\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('535 Authentication failed\r\n'),
        })

      await expect(
        EdgeMailer.connect({
          host: 'smtp.example.com',
          port: 587,
          credentials: {
            username: 'test@example.com',
            password: 'wrong',
          },
          authType: ['plain'],
        }),
      ).rejects.toMatchObject({
        name: 'SMTPError',
        stage: 'auth',
        command: 'AUTH PLAIN',
        responseCode: 535,
        transient: false,
      })
      expect(mockSocket.close).toHaveBeenCalled()
    })

    it('should throw structured error on LOGIN auth failure', async () => {
      mockReader.read
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 smtp.example.com ready\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-AUTH LOGIN\r\n250 AUTH=LOGIN\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('334 VXNlcm5hbWU6\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('334 UGFzc3dvcmQ6\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('535 Authentication failed\r\n'),
        })

      await expect(
        EdgeMailer.connect({
          host: 'smtp.example.com',
          port: 587,
          credentials: {
            username: 'test@example.com',
            password: 'wrong',
          },
          authType: ['login'],
        }),
      ).rejects.toMatchObject({
        name: 'SMTPError',
        stage: 'auth',
        command: 'AUTH LOGIN password',
        responseCode: 535,
        transient: false,
      })
      expect(mockSocket.close).toHaveBeenCalled()
    })

    it('should throw structured error on CRAM-MD5 auth failure', async () => {
      mockReader.read
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 smtp.example.com ready\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-AUTH CRAM-MD5\r\n250 AUTH=CRAM-MD5\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            `334 ${base64('<12345.67890@smtp.example.com>')}\r\n`,
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('535 Authentication failed\r\n'),
        })

      await expect(
        EdgeMailer.connect({
          host: 'smtp.example.com',
          port: 587,
          credentials: {
            username: 'test@example.com',
            password: 'wrong',
          },
          authType: ['cram-md5'],
        }),
      ).rejects.toMatchObject({
        name: 'SMTPError',
        stage: 'auth',
        command: 'AUTH CRAM-MD5',
        responseCode: 535,
        transient: false,
      })
      expect(mockSocket.close).toHaveBeenCalled()
    })

    it('should reject invalid CRAM-MD5 challenge encoding', async () => {
      mockReader.read
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 smtp.example.com ready\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-AUTH CRAM-MD5\r\n250 AUTH=CRAM-MD5\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('334 not base64\r\n'),
        })

      await expect(
        EdgeMailer.connect({
          host: 'smtp.example.com',
          port: 587,
          credentials: {
            username: 'test@example.com',
            password: 'password',
          },
          authType: ['cram-md5'],
        }),
      ).rejects.toMatchObject({
        name: 'SMTPError',
        stage: 'auth',
        command: 'AUTH CRAM-MD5',
      })
      expect(mockSocket.close).toHaveBeenCalled()
    })
  })

  describe('dsn', () => {
    it('should not send DSN if not supported', async () => {
      mockReader.read
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 smtp.example.com ready\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-AUTH PLAIN LOGIN\r\n250 AUTH=PLAIN LOGIN\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('235 Authentication successful\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Sender OK\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Recipient OK\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('354 Start mail input\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Message accepted\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('221 Bye\r\n'),
        })

      const mailer = await EdgeMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials: {
          username: 'test@example.com',
          password: 'password',
        },
        authType: ['plain'],
        dsn: {
          RET: {
            HEADERS: true,
            FULL: false,
          },
          NOTIFY: {
            DELAY: true,
            FAILURE: true,
            SUCCESS: false,
          },
        },
      })

      await mailer.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Test Email with DSN',
        text: 'Hello World',
        dsnOverride: {
          envelopeId: '1234567890',
          RET: {
            HEADERS: false,
            FULL: true,
          },
          NOTIFY: {
            DELAY: false,
            FAILURE: false,
            SUCCESS: true,
          },
        },
      })

      const normalize = (str: string) => str.replace(/\s+/g, ' ').trim()
      const calls = mockWriter.write.mock.calls.map(([arg]: any[]) =>
        normalize(Buffer.from(arg).toString()),
      )

      expect(
        calls.some((call: string) =>
          call.includes(normalize('MAIL FROM: <sender@example.com>')),
        ),
      ).toBe(true)
      expect(
        calls.some((call: string) =>
          call.includes(normalize('RCPT TO: <recipient@example.com>')),
        ),
      ).toBe(true)
    })

    it('dsnOverride should override dsn', async () => {
      mockReader.read
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 smtp.example.com ready\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-AUTH PLAIN LOGIN\r\n250-AUTH=PLAIN LOGIN\r\n250 DSN\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('235 Authentication successful\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Sender OK\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Recipient OK\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('354 Start mail input\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Message accepted\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('221 Bye\r\n'),
        })

      const mailer = await EdgeMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials: {
          username: 'test@example.com',
          password: 'password',
        },
        authType: ['plain'],
        dsn: {
          RET: {
            HEADERS: true,
            FULL: false,
          },
          NOTIFY: {
            DELAY: true,
            FAILURE: true,
            SUCCESS: false,
          },
        },
      })

      await mailer.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Test Email with DSN',
        text: 'Hello World',
        dsnOverride: {
          envelopeId: '1234567890',
          RET: {
            HEADERS: false,
            FULL: true,
          },
          NOTIFY: {
            DELAY: false,
            FAILURE: false,
            SUCCESS: true,
          },
        },
      })

      const normalize = (str: string) => str.replace(/\s+/g, ' ').trim()
      const calls = mockWriter.write.mock.calls.map(([arg]: any[]) =>
        normalize(Buffer.from(arg).toString()),
      )

      expect(
        calls.some((call: string) =>
          call.includes(
            normalize(
              'MAIL FROM: <sender@example.com> RET=FULL ENVID=1234567890',
            ),
          ),
        ),
      ).toBe(true)
      expect(
        calls.some((call: string) =>
          call.includes(
            normalize('RCPT TO: <recipient@example.com> NOTIFY=SUCCESS'),
          ),
        ),
      ).toBe(true)
    })

    it('should send email with DSN request', async () => {
      mockReader.read
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 smtp.example.com ready\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-AUTH PLAIN LOGIN\r\n250-AUTH=PLAIN LOGIN\r\n250 DSN\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('235 Authentication successful\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Sender OK\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Recipient OK\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('354 Start mail input\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Message accepted\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('221 Bye\r\n'),
        })

      const mailer = await EdgeMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials: {
          username: 'test@example.com',
          password: 'password',
        },
        authType: ['plain'],
        dsn: {
          RET: {
            HEADERS: true,
            FULL: false,
          },
          NOTIFY: {
            DELAY: true,
            FAILURE: true,
            SUCCESS: true,
          },
        },
      })

      await mailer.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Test Email with DSN',
        text: 'This is a DSN test email',
        dsnOverride: {
          envelopeId: '1234567890',
        },
      })

      const normalize = (str: string) => str.replace(/\s+/g, ' ').trim()
      const calls = mockWriter.write.mock.calls.map(([arg]: any[]) =>
        normalize(Buffer.from(arg).toString()),
      )

      expect(
        calls.some((call: string) =>
          call.includes(
            normalize(
              'RCPT TO: <recipient@example.com> NOTIFY=SUCCESS,FAILURE,DELAY',
            ),
          ),
        ),
      ).toBe(true)
      expect(
        calls.some((call: string) =>
          call.includes(
            normalize(
              'MAIL FROM: <sender@example.com> RET=HDRS ENVID=1234567890',
            ),
          ),
        ),
      ).toBe(true)
    })
  })

  describe('email sending', () => {
    it('should send email successfully', async () => {
      // Mock successful connection, auth and send sequence
      mockReader.read
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 smtp.example.com ready\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-AUTH PLAIN LOGIN\r\n250 AUTH=PLAIN LOGIN\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('235 Authentication successful\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Sender OK\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Recipient OK\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('354 Start mail input\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Message accepted\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('221 Bye\r\n'),
        })

      const mailer = await EdgeMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials: {
          username: 'test@example.com',
          password: 'password',
        },
        authType: ['plain'],
      })

      await mailer.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Test Email',
        text: 'Hello World',
      })

      // Verify email commands were sent
      expect(mockWriter.write).toHaveBeenCalledWith(expect.any(Uint8Array)) // MAIL FROM
      expect(mockWriter.write).toHaveBeenCalledWith(expect.any(Uint8Array)) // RCPT TO
      expect(mockWriter.write).toHaveBeenCalledWith(expect.any(Uint8Array)) // DATA
      expect(mockWriter.write).toHaveBeenCalledWith(expect.any(Uint8Array)) // Email content
    })

    it('should handle recipient rejection', async () => {
      mockReader.read
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 smtp.example.com ready\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-AUTH PLAIN LOGIN\r\n250 AUTH=PLAIN LOGIN\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('235 Authentication successful\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Sender OK\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('550 Recipient rejected\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Reset OK\r\n'),
        })

      const mailer = await EdgeMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials: {
          username: 'test@example.com',
          password: 'password',
        },
        authType: ['plain'],
      })

      const sendPromise = mailer.send({
        from: 'sender@example.com',
        to: 'invalid@example.com',
        subject: 'Test Email',
        text: 'Hello World',
      })

      await expect(sendPromise).rejects.toMatchObject({
        name: 'SMTPError',
        stage: 'rcpt',
        responseCode: 550,
        transient: false,
      })
    })
  })

  describe('batch sending', () => {
    it('should reuse one SMTP connection for a successful batch', async () => {
      mockReader.read
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 smtp.example.com ready\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-AUTH PLAIN\r\n250 AUTH=PLAIN\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('235 Authentication successful\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Sender OK\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Recipient OK\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('354 Start mail input\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Message accepted\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Sender OK\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Recipient OK\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('354 Start mail input\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Message accepted\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('221 Bye\r\n'),
        })

      const results = await EdgeMailer.sendBatch(
        {
          host: 'smtp.example.com',
          port: 587,
          credentials: {
            username: 'test@example.com',
            password: 'password',
          },
          authType: ['plain'],
        },
        [
          {
            from: 'sender@example.com',
            to: 'recipient1@example.com',
            subject: 'One',
            text: 'Hello one',
          },
          {
            from: 'sender@example.com',
            to: 'recipient2@example.com',
            subject: 'Two',
            text: 'Hello two',
          },
        ],
        { continueOnError: true },
      )

      expect(results.map(result => result.status)).toEqual([
        'fulfilled',
        'fulfilled',
      ])
      expect(connect).toHaveBeenCalledTimes(1)
      expect(
        writtenLines().filter(line => line.startsWith('AUTH PLAIN')),
      ).toHaveLength(1)
      expect(
        writtenLines().filter(line => line.startsWith('MAIL FROM')),
      ).toHaveLength(2)
    })

    it('should return ordered rejected and fulfilled results when continuing after an error', async () => {
      mockReader.read
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 smtp.example.com ready\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-AUTH PLAIN\r\n250 AUTH=PLAIN\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('235 Authentication successful\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Sender OK\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('550 Recipient rejected\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Reset OK\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Sender OK\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Recipient OK\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('354 Start mail input\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Message accepted\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('221 Bye\r\n'),
        })

      const results = await EdgeMailer.sendBatch(
        {
          host: 'smtp.example.com',
          port: 587,
          credentials: {
            username: 'test@example.com',
            password: 'password',
          },
          authType: ['plain'],
        },
        [
          {
            from: 'sender@example.com',
            to: 'invalid@example.com',
            subject: 'Rejected',
            text: 'Hello bad',
          },
          {
            from: 'sender@example.com',
            to: 'recipient@example.com',
            subject: 'Accepted',
            text: 'Hello good',
          },
        ],
        { continueOnError: true },
      )

      expect(results[0]).toMatchObject({
        status: 'rejected',
        reason: {
          name: 'SMTPError',
          stage: 'rcpt',
          responseCode: 550,
        },
      })
      expect(results[1]).toMatchObject({ status: 'fulfilled' })
      expect(writtenLines()).toContain('RSET\r\n')
      expect(connect).toHaveBeenCalledTimes(1)
    })
  })

  describe('pipelining', () => {
    it('should pipeline MAIL, RCPT, and DATA before writing the body', async () => {
      mockReader.read
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 smtp.example.com ready\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-PIPELINING\r\n250-AUTH PLAIN\r\n250 AUTH=PLAIN\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('235 Authentication successful\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Sender OK\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Recipient OK\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('354 Start mail input\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Message accepted\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('221 Bye\r\n'),
        })

      const mailer = await EdgeMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials: {
          username: 'test@example.com',
          password: 'password',
        },
        authType: ['plain'],
      })

      await mailer.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Pipelined',
        text: 'Hello World',
      })
      await mailer.close()

      const writes = writtenLines()
      const mailIndex = writes.findIndex(line => line.startsWith('MAIL FROM'))
      const rcptIndex = writes.findIndex(line => line.startsWith('RCPT TO'))
      const dataIndex = writes.findIndex(line => line === 'DATA\r\n')
      const bodyIndex = writes.findIndex(line =>
        line.startsWith('MIME-Version: 1.0'),
      )

      expect(mailIndex).toBeGreaterThan(-1)
      expect(rcptIndex).toBeGreaterThan(mailIndex)
      expect(dataIndex).toBeGreaterThan(rcptIndex)
      expect(bodyIndex).toBeGreaterThan(dataIndex)
    })

    it('should handle pipelined SMTP replies coalesced in one socket read', async () => {
      mockReader.read
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 smtp.example.com ready\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-PIPELINING\r\n250-AUTH PLAIN\r\n250 AUTH=PLAIN\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('235 Authentication successful\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250 Sender OK\r\n250 Recipient OK\r\n354 Start mail input\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Message accepted\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('221 Bye\r\n'),
        })

      const mailer = await EdgeMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials: {
          username: 'test@example.com',
          password: 'password',
        },
        authType: ['plain'],
      })

      await mailer.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Pipelined',
        text: 'Hello World',
      })
      await mailer.close()

      expect(
        writtenLines().some(line => line.startsWith('MIME-Version: 1.0')),
      ).toBe(true)
    })
  })

  describe('shutdown', () => {
    it('should reject a queued send after shutdown', async () => {
      let releaseBodyRead!: (value: { done: boolean }) => void
      let bodyReadStarted!: () => void
      const bodyReadStartedPromise = new Promise<void>(resolve => {
        bodyReadStarted = resolve
      })
      mockSocket.close = vi.fn().mockImplementation(() => {
        releaseBodyRead?.({ done: true })
        return Promise.resolve()
      })

      mockReader.read
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 smtp.example.com ready\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-AUTH PLAIN\r\n250 AUTH=PLAIN\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('235 Authentication successful\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Sender OK\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('250 Recipient OK\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('354 Start mail input\r\n'),
        })
        .mockImplementationOnce(
          () =>
            new Promise(resolve => {
              releaseBodyRead = resolve
              bodyReadStarted()
            }),
        )

      const mailer = await EdgeMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials: {
          username: 'test@example.com',
          password: 'password',
        },
        authType: ['plain'],
      })

      const first = mailer.send({
        from: 'sender@example.com',
        to: 'recipient1@example.com',
        subject: 'First',
        text: 'Hello one',
      })
      const firstHandled = first.then(
        () => undefined,
        error => error as Error,
      )
      const second = mailer.send({
        from: 'sender@example.com',
        to: 'recipient2@example.com',
        subject: 'Second',
        text: 'Hello two',
      })
      const secondHandled = second.then(
        () => undefined,
        error => error as Error,
      )

      await bodyReadStartedPromise
      await mailer.close(new Error('shutdown'))
      expect(await firstHandled).toBeInstanceOf(Error)
      expect((await secondHandled).message).toBe('shutdown')
    })
  })

  describe('close', () => {
    it('should close connection properly', async () => {
      mockReader.read
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('220 smtp.example.com ready\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            '250-smtp.example.com\r\n250-AUTH PLAIN LOGIN\r\n250 AUTH=PLAIN LOGIN\r\n',
          ),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('235 Authentication successful\r\n'),
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('221 Bye\r\n'),
        })

      const mailer = await EdgeMailer.connect({
        host: 'smtp.example.com',
        port: 587,
        credentials: {
          username: 'test@example.com',
          password: 'password',
        },
        authType: ['plain'],
      })

      await mailer.close()

      expect(mockWriter.write).toHaveBeenCalledWith(expect.any(Uint8Array)) // QUIT command
      expect(mockSocket.close).toHaveBeenCalled()
    })
  })
})
