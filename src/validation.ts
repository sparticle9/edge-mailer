/** Rejects control characters in values inserted into protocol headers. */
export function assertHeaderValue(value: string, field: string): void {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${field} must be a string without control characters`)
  }
}

/** Validates a bare mailbox without accepting SMTP path delimiters. */
export function assertMailbox(
  value: string,
  field: string,
  allowEmpty = false,
): void {
  assertHeaderValue(value, field)
  if ((value === '' && !allowEmpty) || /[<>\s]/u.test(value)) {
    throw new Error(
      `${field} must be a bare mailbox without whitespace or angle brackets`,
    )
  }
}

/** Escapes a validated MIME quoted-string. */
export function quoteHeaderValue(value: string): string {
  assertHeaderValue(value, 'Quoted header value')
  return value.replace(/["\\]/g, '\\$&')
}
