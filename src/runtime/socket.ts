/** TLS mode requested from a runtime socket adapter. */
export type SocketTlsMode = 'off' | 'on' | 'starttls'

/** Minimal readable/writable socket contract used by the SMTP core. */
export type EdgeSocket = {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
  opened?: Promise<unknown>
  closed?: Promise<void>
  close(reason?: unknown): Promise<void> | void
  startTls?(): EdgeSocket | Promise<EdgeSocket>
}

/** Runtime socket connection request. */
export type EdgeSocketConnectOptions = {
  hostname: string
  port: number
  tls: SocketTlsMode
  signal?: AbortSignal
}

/** Runtime adapter that opens SMTP TCP/TLS sockets. */
export type EdgeSocketConnector = {
  connect(options: EdgeSocketConnectOptions): EdgeSocket | Promise<EdgeSocket>
}
