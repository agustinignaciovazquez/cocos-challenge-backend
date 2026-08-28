import { BadRequestException } from '@nestjs/common';
import { idempotencyKey } from './idempotency-key';

describe('idempotencyKey', () => {
  it('refuses a request that sends no key', () => {
    expect(() => idempotencyKey(undefined)).toThrow(BadRequestException);
    // Its own message: a caller that sent nothing is asked for a key, not told its key
    // was the wrong shape.
    expect(() => idempotencyKey(undefined)).toThrow(
      /^Idempotency-Key is required/,
    );
  });

  it('takes letters, digits, underscores and hyphens, up to 64 of them', () => {
    expect(idempotencyKey('a')).toBe('a');
    expect(idempotencyKey('7f3a1c9e-4b2d_PAMP-10')).toBe(
      '7f3a1c9e-4b2d_PAMP-10',
    );
    expect(idempotencyKey('k'.repeat(64))).toBe('k'.repeat(64));
  });

  it('refuses a key past 64 characters', () => {
    expect(() => idempotencyKey('k'.repeat(65))).toThrow(BadRequestException);
  });

  it('refuses a header that is present but empty', () => {
    expect(() => idempotencyKey('')).toThrow(BadRequestException);
  });

  it('refuses every character outside the alphabet, newlines included', () => {
    for (const bad of ['has space', 'a/b', 'a.b', 'a%b', 'ñ', 'ok\n', '\nok']) {
      expect(() => idempotencyKey(bad)).toThrow(BadRequestException);
    }
  });
});
