import { Prisma } from '@prisma/client';

// Money is counted in centavos so every calculation is integer arithmetic, and counted in
// `bigint` because the widest one is a size times a price: a max INT4 size at the top
// NUMERIC(10, 2) price is 2147483647 × 9999999999 ≈ 2·10^19 centavos, past the 2^53 a
// `number` holds exactly.
const PESOS = /^(-?)(\d+)(?:\.(\d{1,2}))?$/;

export function centavosFromDb(value: Prisma.Decimal | string): bigint {
  const text = value.toString();
  const match = PESOS.exec(text);
  if (match === null) {
    throw new RangeError(`${text} is not an amount of pesos with two decimals`);
  }

  const [, sign, pesos, decimals = ''] = match;
  const centavos = BigInt(pesos + decimals.padEnd(2, '0'));
  return sign === '-' ? -centavos : centavos;
}

export function centavosFromApi(input: number): bigint {
  return centavosFromDb(String(input));
}

export function apiString(centavos: bigint): string {
  const sign = centavos < 0n ? '-' : '';
  const digits = (centavos < 0n ? -centavos : centavos)
    .toString()
    .padStart(3, '0');
  return `${sign}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}
