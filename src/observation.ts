/** Observation mode for SMTP lifecycle events. */
export type MailObservationMode = 'summary' | 'transcript'

/** Stable observation event names emitted by the SMTP core and pool. */
export type MailObservationEventType =
  | 'mail.send.started'
  | 'mail.compose.completed'
  | 'smtp.connect.completed'
  | 'smtp.greet.completed'
  | 'smtp.ehlo.completed'
  | 'smtp.starttls.completed'
  | 'smtp.auth.completed'
  | 'smtp.envelope.completed'
  | 'smtp.data.completed'
  | 'smtp.rset.completed'
  | 'mail.send.completed'
  | 'mail.send.failed'
  | 'smtp.pool.acquire.completed'
  | 'smtp.pool.connection.created'
  | 'smtp.pool.connection.reused'
  | 'smtp.pool.connection.closed'

/** Stage outcome carried by observation events. */
export type MailObservationStatus =
  | 'started'
  | 'completed'
  | 'failed'
  | 'skipped'

/** Compact failure reasons intended for retry policy and agent routing. */
export type MailFailureReason =
  | 'aborted'
  | 'connect_failed'
  | 'timeout'
  | 'tls_failed'
  | 'auth_failed'
  | 'auth_expired_token'
  | 'auth_invalid_scope'
  | 'auth_disabled'
  | 'sender_rejected'
  | 'recipient_rejected'
  | 'data_rejected'
  | 'unsupported_extension'
  | 'rate_limited'
  | 'server_rejected'
  | 'client_closed'
  | 'unknown'

/** Retry guidance derived from SMTP stage and response metadata. */
export type MailRetryHint = 'retry' | 'do_not_retry' | 'unknown'

/** Suggested next action for callers and automation. */
export type MailNextAction =
  | 'retry'
  | 'refresh_token'
  | 'check_starttls'
  | 'check_credentials'
  | 'check_sender'
  | 'check_recipient'
  | 'check_message'
  | 'check_server_policy'
  | 'reduce_message_size'
  | 'inspect_error'
  | 'none'

/** Optional instrumentation hook for SMTP lifecycle events. */
export type MailObservationOptions = {
  onEvent?: (event: MailObservationEvent) => void
  mode?: MailObservationMode
}

/** JSON-safe SMTP/pool lifecycle event. */
export type MailObservationEvent = {
  version: 1
  type: MailObservationEventType
  status: MailObservationStatus
  runtime: string
  sessionId: string
  attemptId?: string
  stage?: string
  timestamp: string
  durationMs?: number
  responseCode?: number
  enhancedStatusCode?: string
  command?: string
  response?: string
  capabilities?: string[]
  reason?: MailFailureReason
  retryHint?: MailRetryHint
  nextAction?: MailNextAction
  tlsMode?: 'none' | 'implicit' | 'starttls'
  messageSize?: number
  acceptedCount?: number
  rejectedCount?: number
  pool?: {
    waitMs?: number
    ready?: number
    busy?: number
    totalConnections?: number
  }
}

export type MailFailureInput = {
  stage?: string
  message?: string
  responseCode?: number
}

export type MailFailureClassification = {
  reason: MailFailureReason
  retryHint: MailRetryHint
  nextAction: MailNextAction
}

const REDACTED = '<redacted>'
const MESSAGE_BODY_REDACTED = '<message body redacted>'

/** Generates a stable-enough id without importing runtime-specific modules. */
export function createObservationId(prefix: string): string {
  const cryptoApi = (
    globalThis as {
      crypto?: {
        randomUUID?: () => string
      }
    }
  ).crypto
  const random =
    typeof cryptoApi?.randomUUID === 'function'
      ? cryptoApi.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36)
  return `${prefix}_${random}`
}

/** Returns a non-negative millisecond duration from a Date.now() start value. */
export function durationSince(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt)
}

/** Redacts secrets and message content from SMTP client commands. */
export function redactSmtpCommand(command: string): string {
  const normalized = trimTrailingLineBreak(command)
  if (!normalized) {
    return normalized
  }
  if (normalized === '<message body>' || normalized.includes('\n')) {
    return MESSAGE_BODY_REDACTED
  }
  if (/^AUTH\s+PLAIN\b/i.test(normalized)) {
    return 'AUTH PLAIN <redacted>'
  }
  if (/^AUTH\s+XOAUTH2\b/i.test(normalized)) {
    return 'AUTH XOAUTH2 <redacted>'
  }
  if (/^AUTH\s+CRAM-MD5\b/i.test(normalized)) {
    return 'AUTH CRAM-MD5'
  }
  if (/^[A-Za-z0-9+/=]{8,}$/.test(normalized)) {
    return REDACTED
  }
  return redactInlineSecrets(redactEmailAddresses(normalized))
}

/** Redacts email local parts and known secret tokens from SMTP responses. */
export function redactSmtpResponse(response: string): string {
  return redactInlineSecrets(
    redactEmailAddresses(trimTrailingLineBreak(response)),
  )
}

/** Derives compact failure metadata from SMTP stage and response details. */
export function classifyMailFailure(
  input: MailFailureInput,
): MailFailureClassification {
  const stage = input.stage || ''
  const message = (input.message || '').toLowerCase()
  const responseCode = input.responseCode
  const reason = failureReason(stage, message, responseCode)
  return {
    reason,
    retryHint: retryHint(reason, responseCode),
    nextAction: nextAction(reason, responseCode),
  }
}

function failureReason(
  stage: string,
  message: string,
  responseCode?: number,
): MailFailureReason {
  if (message.includes('timeout')) {
    return 'timeout'
  }
  if (message.includes('aborted') || message.includes('aborterror')) {
    return 'aborted'
  }
  if (
    message.includes('edgemailer is closed') ||
    message.includes('connection aborted') ||
    message.includes('shutting down')
  ) {
    return 'client_closed'
  }
  if (stage === 'connect' || stage === 'greet' || stage === 'read') {
    return 'connect_failed'
  }
  if (stage === 'starttls') {
    return 'tls_failed'
  }
  if (stage === 'auth') {
    if (
      message.includes('expired') ||
      message.includes('invalid_token') ||
      message.includes('token expired')
    ) {
      return 'auth_expired_token'
    }
    if (
      message.includes('scope') ||
      message.includes('insufficient') ||
      message.includes('invalid_scope')
    ) {
      return 'auth_invalid_scope'
    }
    if (
      message.includes('disabled') ||
      message.includes('smtp auth') ||
      message.includes('5.7.139') ||
      message.includes('5.7.57')
    ) {
      return 'auth_disabled'
    }
    return 'auth_failed'
  }
  if (responseCode === 421 || responseCode === 451 || responseCode === 452) {
    return 'rate_limited'
  }
  if (message.includes('8bitmime') || message.includes('smtputf8')) {
    return 'unsupported_extension'
  }
  if (message.includes('requiretls')) {
    return 'unsupported_extension'
  }
  if (stage === 'mail') {
    return responseCode ? 'sender_rejected' : 'unsupported_extension'
  }
  if (stage === 'rcpt') {
    return 'recipient_rejected'
  }
  if (stage === 'data' || stage === 'body') {
    return 'data_rejected'
  }
  if (responseCode) {
    return 'server_rejected'
  }
  return 'unknown'
}

function retryHint(
  reason: MailFailureReason,
  responseCode?: number,
): MailRetryHint {
  if (responseCode && responseCode >= 400 && responseCode < 500) {
    return 'retry'
  }
  if (responseCode && responseCode >= 500) {
    return 'do_not_retry'
  }
  if (
    reason === 'timeout' ||
    reason === 'connect_failed' ||
    reason === 'rate_limited'
  ) {
    return 'retry'
  }
  if (
    reason === 'aborted' ||
    reason === 'auth_failed' ||
    reason === 'auth_expired_token' ||
    reason === 'auth_invalid_scope' ||
    reason === 'auth_disabled' ||
    reason === 'unsupported_extension' ||
    reason === 'client_closed'
  ) {
    return 'do_not_retry'
  }
  return 'unknown'
}

function nextAction(
  reason: MailFailureReason,
  responseCode?: number,
): MailNextAction {
  if (responseCode === 552) {
    return 'reduce_message_size'
  }
  if (
    reason === 'timeout' ||
    reason === 'connect_failed' ||
    reason === 'rate_limited'
  ) {
    return 'retry'
  }
  if (reason === 'tls_failed') {
    return 'check_starttls'
  }
  if (reason === 'auth_expired_token') {
    return 'refresh_token'
  }
  if (reason === 'auth_failed') {
    return 'check_credentials'
  }
  if (reason === 'auth_invalid_scope' || reason === 'auth_disabled') {
    return 'check_server_policy'
  }
  if (reason === 'sender_rejected') {
    return 'check_sender'
  }
  if (reason === 'recipient_rejected') {
    return 'check_recipient'
  }
  if (reason === 'data_rejected') {
    return 'check_message'
  }
  if (reason === 'unsupported_extension') {
    return 'check_server_policy'
  }
  if (reason === 'aborted' || reason === 'client_closed') {
    return 'none'
  }
  if (reason === 'server_rejected' && responseCode && responseCode < 500) {
    return 'retry'
  }
  return 'inspect_error'
}

function trimTrailingLineBreak(value: string): string {
  return value.replace(/(?:\r?\n)+$/g, '')
}

function redactEmailAddresses(value: string): string {
  return value.replace(
    /([A-Z0-9._%+-]+)@([A-Z0-9.-]+\.[A-Z]{2,})/gi,
    (_match, _local: string, domain: string) => `***@${domain}`,
  )
}

function redactInlineSecrets(value: string): string {
  return value
    .replace(
      /(password|passwd|token|access_token|refresh_token)=([^&\s]+)/gi,
      `$1=${REDACTED}`,
    )
    .replace(/(Bearer)\s+[A-Za-z0-9._~+/-]+=*/gi, `$1 ${REDACTED}`)
}
