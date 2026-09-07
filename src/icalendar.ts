import { assertHeaderValue, assertMailbox } from './validation.ts'

/**
 * iCalendar (RFC 5545) event model and generator.
 *
 * Produces a valid .ics attachment suitable for MIME `text/calendar; method=REQUEST`.
 * Gmail, Outlook, and Apple Mail all render RSVP buttons natively from these invites.
 *
 * @module icalendar
 */

/** A single attendee with optional RSVP expectation. */
export type CalendarAttendee = {
  /** Display name. */
  name?: string
  /** Email address (required). */
  email: string
  /** Role: CHAIR (organizer), REQ-PARTICIPANT (required), OPT-PARTICIPANT (optional). */
  role?: 'CHAIR' | 'REQ-PARTICIPANT' | 'OPT-PARTICIPANT'
  /** Whether the organizer expects an RSVP from this attendee. Default true. */
  rsvp?: boolean
}

/** UTC date-time string (YYYYMMDDTHHMMSSZ) or a local date-only string (YYYYMMDD). */
export type IcsDateValue = string

/** High-level options for generating an iCalendar event. */
export type ICalendarOptions = {
  /** Event summary / title (required). */
  summary: string
  /** Optional longer description. */
  description?: string
  /** Event start (required). ISO 8601 UTC or date-only. */
  start: IcsDateValue
  /** Event end (required). ISO 8601 UTC or date-only. */
  end: IcsDateValue
  /** Geographic location string. */
  location?: string
  /** Organizer name and email. */
  organizer?: { name?: string; email: string }
  /** Attendees. */
  attendees?: CalendarAttendee[]
  /** Unique event identifier. If omitted, a UUID is generated. */
  uid?: string
  /** iCalendar METHOD header for the MIME part. Default: REQUEST. */
  method?: 'REQUEST' | 'CANCEL' | 'PUBLISH'
  /** Sequence number for update/cancel scenarios. Default 0. */
  sequence?: number
  /** DTSTAMP override (timestamp when the ICS was generated). */
  dtstamp?: IcsDateValue
}

function textLines(text: string, maxLen = 75): string {
  const lines: string[] = []
  let line = ''
  let bytes = 0
  for (const char of text) {
    const length = new TextEncoder().encode(char).length
    if (bytes + length > maxLen) {
      lines.push(line)
      line = ' '
      bytes = 1
    }
    line += char
    bytes += length
  }
  lines.push(line)
  return lines.join('\r\n')
}

function escapeIcsText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
}

function utcNow(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return [
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
    'T',
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
    pad(now.getUTCSeconds()),
    'Z',
  ].join('')
}

/**
 * Serializes calendar event options into a valid iCalendar string (RFC 5545 VCALENDAR).
 */
export function createIcsString(options: ICalendarOptions): string {
  const dtstamp = options.dtstamp || utcNow()
  const uid = options.uid || crypto.randomUUID()
  const seq = options.sequence ?? 0
  const method = options.method || 'REQUEST'
  assertHeaderValue(uid, 'Calendar uid')
  if (
    !['REQUEST', 'CANCEL', 'PUBLISH'].includes(method) ||
    !Number.isSafeInteger(seq) ||
    seq < 0
  ) {
    throw new Error('Invalid calendar method or sequence')
  }
  for (const date of [options.start, options.end, dtstamp]) {
    if (!/^(?:\d{8}|\d{8}T\d{6}Z)$/.test(date)) {
      throw new Error('Calendar dates must use YYYYMMDD or YYYYMMDDTHHMMSSZ')
    }
  }
  const parameter = (name: string) => {
    assertHeaderValue(name, 'Calendar display name')
    return `"${name.replace(/\^/g, '^^').replace(/"/g, "^'")}"`
  }

  const lines: string[] = []

  // VCALENDAR wrapper
  lines.push('BEGIN:VCALENDAR')
  lines.push('VERSION:2.0')
  lines.push('PRODID:-//Edge Mailer//Calendar//EN')
  lines.push(`METHOD:${method}`)

  // VEVENT
  lines.push('BEGIN:VEVENT')
  lines.push(`UID:${escapeIcsText(uid)}`)
  lines.push(`DTSTAMP:${dtstamp}`)
  lines.push(
    `DTSTART${options.start.length === 8 ? ';VALUE=DATE' : ''}:${options.start}`,
  )
  lines.push(
    `DTEND${options.end.length === 8 ? ';VALUE=DATE' : ''}:${options.end}`,
  )
  lines.push(`SEQUENCE:${seq}`)
  lines.push(`SUMMARY:${escapeIcsText(options.summary)}`)

  if (options.description) {
    lines.push(`DESCRIPTION:${escapeIcsText(options.description)}`)
  }

  if (options.location) {
    lines.push(`LOCATION:${escapeIcsText(options.location)}`)
  }

  // Organizer
  if (options.organizer) {
    assertMailbox(options.organizer.email, 'Calendar organizer')
    const orgParam = options.organizer.name
      ? `;CN=${parameter(options.organizer.name)}`
      : ''
    lines.push(`ORGANIZER${orgParam}:mailto:${options.organizer.email}`)
  }

  // Attendees
  for (const a of options.attendees || []) {
    assertMailbox(a.email, 'Calendar attendee')
    if (
      a.role &&
      !['CHAIR', 'REQ-PARTICIPANT', 'OPT-PARTICIPANT'].includes(a.role)
    ) {
      throw new Error('Invalid calendar attendee role')
    }
    const parts: string[] = []
    if (a.name) parts.push(`CN=${parameter(a.name)}`)
    if (a.role) parts.push(`ROLE=${a.role}`)
    parts.push(`RSVP=${a.rsvp !== false ? 'TRUE' : 'FALSE'}`)
    parts.push(`PARTSTAT=NEEDS-ACTION`)
    lines.push(`ATTENDEE;${parts.join(';')}:mailto:${a.email}`)
  }

  // Close
  lines.push('END:VEVENT')
  lines.push('END:VCALENDAR')

  // Apply text folding (75 char max per line)
  return lines.map(line => textLines(line)).join('\r\n') + '\r\n'
}

/**
 * Returns a ready-to-attach object for use with EmailOptions.attachments.
 * The caller can spread or push this into their attachments array.
 */
export function createIcsAttachment(options: ICalendarOptions): {
  filename: string
  content: string
  mimeType: string
  encoding: 'base64'
} {
  const icsString = createIcsString(options)
  // Encode to base64 for safe MIME transport
  const base64 = btoa(
    Array.from(new TextEncoder().encode(icsString), byte =>
      String.fromCharCode(byte),
    ).join(''),
  )
  return {
    filename: `invite.ics`,
    content: base64,
    mimeType: `text/calendar; charset=UTF-8; method=${options.method || 'REQUEST'}`,
    encoding: 'base64' as const,
  }
}
