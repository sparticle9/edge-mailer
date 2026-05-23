export type SocketTlsMode = 'off' | 'on' | 'starttls'

export type EdgeSocket = {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
  opened?: Promise<unknown>
  closed?: Promise<void>
  close(reason?: unknown): Promise<void> | void
  startTls?(): EdgeSocket | Promise<EdgeSocket>
}

export type EdgeSocketConnectOptions = {
  hostname: string
  port: number
  tls: SocketTlsMode
  signal?: AbortSignal
}

export type EdgeSocketConnector = {
  connect(options: EdgeSocketConnectOptions): EdgeSocket | Promise<EdgeSocket>
}
