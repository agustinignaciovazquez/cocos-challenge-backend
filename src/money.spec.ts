import { Prisma } from '@prisma/client';
import { apiString, centavosFromApi, centavosFromDb } from './money';

describe('centavosFromApi', () => {
  it('reads a validated request number as exact centavos', () => {
    expect(centavosFromApi(925.85)).toBe(92585n);
    expect(centavosFromApi(900)).toBe(90000n);
    expect(centavosFromApi(0.1)).toBe(10n);
  });

  it('reads the smallest and the largest money the columns hold', () => {
    expect(centavosFromApi(0.01)).toBe(1n);
    expect(centavosFromApi(99_999_999.99)).toBe(9_999_999_999n);
  });

  it('refuses what the request validator would never have let through', () => {
    expect(() => centavosFromApi(100.999)).toThrow(RangeError);
    expect(() => centavosFromApi(0.1 + 0.2)).toThrow(RangeError);
    expect(() => centavosFromApi(1e-7)).toThrow(RangeError);
    expect(() => centavosFromApi(1e21)).toThrow(RangeError);
  });
});

describe('centavosFromDb', () => {
  it('reads a NUMERIC(10, 2) value exactly', () => {
    expect(centavosFromDb(new Prisma.Decimal('925.85'))).toBe(92585n);
    expect(centavosFromDb(new Prisma.Decimal('0.00'))).toBe(0n);
    expect(centavosFromDb(new Prisma.Decimal('99999999.99'))).toBe(
      9_999_999_999n,
    );
  });

  it('restores the trailing zeros a decimal prints without', () => {
    expect(centavosFromDb(new Prisma.Decimal('1.50'))).toBe(150n);
    expect(centavosFromDb('7')).toBe(700n);
  });

  it('carries a negative balance through', () => {
    expect(centavosFromDb(new Prisma.Decimal('-1234.50'))).toBe(-123450n);
    expect(centavosFromDb('-0.01')).toBe(-1n);
  });
});

describe('apiString', () => {
  it('writes two decimals whatever the magnitude', () => {
    expect(apiString(92585n)).toBe('925.85');
    expect(apiString(0n)).toBe('0.00');
    expect(apiString(1n)).toBe('0.01');
    expect(apiString(9_999_999_999n)).toBe('99999999.99');
  });

  it('keeps the sign in front of the pesos', () => {
    expect(apiString(-1n)).toBe('-0.01');
    expect(apiString(-123450n)).toBe('-1234.50');
  });

  it('round-trips every value a request can carry', () => {
    const written: [number, string][] = [
      [0.01, '0.01'],
      [1, '1.00'],
      [99.9, '99.90'],
      [925.85, '925.85'],
      [99_999_999.99, '99999999.99'],
    ];

    for (const [value, expected] of written) {
      expect(apiString(centavosFromApi(value))).toBe(expected);
    }
  });
});
