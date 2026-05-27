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
  for (let i = 0; i < text.length; i += maxLen) {
    const chunk = text.slice(i, i + maxLen)
    lines.push(i === 0 ? chunk : ` ${chunk}`)
  }
  return lines.join('\r\n')
}

function escapeIcsText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
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

  const lines: string[] = []

  // VCALENDAR wrapper
  lines.push('BEGIN:VCALENDAR')
  lines.push('VERSION:2.0')
  lines.push('PRODID:-//Edge Mailer//Calendar//EN')
  lines.push(`METHOD:${method}`)

  // VEVENT
  lines.push('BEGIN:VEVENT')
  lines.push(`UID:${uid}`)
  lines.push(`DTSTAMP:${dtstamp}`)
  lines.push(`DTSTART:${options.start}`)
  lines.push(`DTEND:${options.end}`)
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
    const orgParam = options.organizer.name
      ? `;CN=${escapeIcsText(options.organizer.name)}`
      : ''
    lines.push(`ORGANIZER${orgParam}:mailto:${options.organizer.email}`)
  }

  // Attendees
  for (const a of options.attendees || []) {
    const parts: string[] = []
    if (a.name) parts.push(`CN=${escapeIcsText(a.name)}`)
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
  const uid = options.uid || `edge-mailer-ics`
  // Encode to base64 for safe MIME transport
  const base64 = btoa(icsString)
  return {
    filename: `invite.ics`,
    content: base64,
    mimeType: `text/calendar; charset=UTF-8; method=${options.method || 'REQUEST'}`,
    encoding: 'base64' as const,
  }
}
