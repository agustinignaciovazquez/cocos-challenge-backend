import { BadRequestException } from '@nestjs/common';

// Anchored with a lookahead, not `$`: in JavaScript `$` also matches before a trailing
// newline, the one character a header value must never carry through.
const KEY = /^[A-Za-z0-9_-]{1,64}(?![\s\S])/;

// A function rather than a pipe: `@Headers()` is the one param decorator Nest runs no
// pipes for. The 64 is the column's only bound — the schema stores the key as TEXT.
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
