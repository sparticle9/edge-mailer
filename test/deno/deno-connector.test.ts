import {
  createDenoSocketConnector,
  type DenoSocketRuntime,
} from '../../src/runtime/deno.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

function assertEquals<T>(actual: T, expected: T, message?: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      message ||
        `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    )
  }
}

function createConn(label: string) {
  let closed = false
  return {
    label,
    get closedState() {
      return closed
    },
    readable: new ReadableStream<Uint8Array>(),
    writable: new WritableStream<Uint8Array>(),
    close() {
      closed = true
    },
  }
}

Deno.test(
  'Deno connector opens plain TCP without STARTTLS upgrade',
  async () => {
    const calls: string[] = []
    const plainConn = createConn('plain')
    const deno: DenoSocketRuntime = {
      async connect(options) {
        calls.push(`connect:${options.hostname}:${options.port}`)
        return plainConn
      },
      async connectTls() {
        throw new Error('connectTls should not be called')
      },
      async startTls() {
        throw new Error('startTls should not be called')
      },
    }

    const socket = await createDenoSocketConnector(deno).connect({
      hostname: 'smtp.example.com',
      port: 25,
      tls: 'off',
    })

    assertEquals(calls, ['connect:smtp.example.com:25'])
    assert(
      socket.startTls === undefined,
      'plain TCP socket should not expose startTls',
    )
    await socket.close()
    assert(plainConn.closedState, 'plain connection should close')
  },
)

Deno.test('Deno connector opens implicit TLS with connectTls', async () => {
  const calls: string[] = []
  const tlsConn = createConn('tls')
  const deno: DenoSocketRuntime = {
    async connect() {
      throw new Error('connect should not be called')
    },
    async connectTls(options) {
      calls.push(`connectTls:${options.hostname}:${options.port}`)
      return tlsConn
    },
    async startTls() {
      throw new Error('startTls should not be called')
    },
  }

  const socket = await createDenoSocketConnector(deno).connect({
    hostname: 'smtp.example.com',
    port: 465,
    tls: 'on',
  })

  assertEquals(calls, ['connectTls:smtp.example.com:465'])
  assert(
    socket.startTls === undefined,
    'implicit TLS socket should not expose startTls',
  )
  await socket.close()
  assert(tlsConn.closedState, 'TLS connection should close')
})

Deno.test(
  'Deno connector upgrades STARTTLS through Deno.startTls',
  async () => {
    const calls: string[] = []
    const plainConn = createConn('plain')
    const upgradedConn = createConn('upgraded')
    const deno: DenoSocketRuntime = {
      async connect(options) {
        calls.push(`connect:${options.hostname}:${options.port}`)
        return plainConn
      },
      async connectTls() {
        throw new Error('connectTls should not be called')
      },
      async startTls(conn, options) {
        calls.push(`startTls:${options?.hostname}`)
        assert(
          conn === plainConn,
          'startTls should consume the original TCP connection',
        )
        return upgradedConn
      },
    }

    const socket = await createDenoSocketConnector(deno).connect({
      hostname: 'smtp.example.com',
      port: 587,
      tls: 'starttls',
    })
    assert(socket.startTls, 'STARTTLS socket should expose startTls')

    const upgraded = await socket.startTls()
    assertEquals(calls, [
      'connect:smtp.example.com:587',
      'startTls:smtp.example.com',
    ])
    assert(
      upgraded.startTls === undefined,
      'upgraded TLS socket should not expose startTls again',
    )
    await upgraded.close()
    assert(upgradedConn.closedState, 'upgraded connection should close')
  },
)
