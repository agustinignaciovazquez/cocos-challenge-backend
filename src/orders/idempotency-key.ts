import { BadRequestException } from '@nestjs/common';

// Anchored with a lookahead rather than `$`, which in JavaScript matches before a trailing
// newline too — the one character a header value must never carry through.
const KEY = /^[A-Za-z0-9_-]{1,64}(?![\s\S])/;

// A function rather than a pipe because `@Headers()` is the one param decorator Nest does
// not run pipes for. The alphabet is deliberately narrow: the key is opaque to this
// service, so refusing whitespace, newlines and anything past 64 characters costs a caller
// nothing and gives the column a bound the schema does not. An absent header is refused
// rather than let through, because a safety a caller may skip is not one this service can
// promise — the duplicate it prevents costs money, and only the caller's own key names the
// order a retry repeats.
export function idempotencyKey(sent: string | undefined): string {
  if (sent === undefined) {
    throw new BadRequestException(
      'Idempotency-Key is required: 1 to 64 characters of A-Z, a-z, 0-9, _ or -',
    );
  }
  if (!KEY.test(sent)) {
    throw new BadRequestException(
      'Idempotency-Key must be 1 to 64 characters of A-Z, a-z, 0-9, _ or -',
    );
  }
  return sent;
}
