import {
  IsIn,
  IsInt,
  isNumber,
  IsPositive,
  Max,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { MAX_INT4 } from '../int4';
import { OrderType, ORDER_TYPES, Side, SIDES } from './order-rules';

const MIN_MONEY = 0.01;
const MAX_MONEY = 99_999_999.99; // NUMERIC(10, 2)

// The range is measured before the decimals: class-validator counts those off
// `value.toString().split('.')[1]`, which is undefined — and throws — on the exponent form
// JavaScript renders below 1e-6 and from 1e21 up.
const isMoney = (value: unknown): boolean =>
  isNumber(value) &&
  value >= MIN_MONEY &&
  value <= MAX_MONEY &&
  isNumber(value, { maxDecimalPlaces: 2 });

const isSize = (value: unknown): boolean =>
  isNumber(value) && Number.isInteger(value) && value >= 1 && value <= MAX_INT4;

@ValidatorConstraint({ name: 'limitPrice' })
class LimitPrice implements ValidatorConstraintInterface {
  validate(price: unknown, { object }: ValidationArguments): boolean {
    return (object as PlaceOrderDto).type === 'LIMIT'
      ? isMoney(price)
      : price === undefined;
  }

  defaultMessage(): string {
    return `price must be between ${MIN_MONEY} and ${MAX_MONEY} on LIMIT orders and absent on MARKET orders`;
  }
}

// The exclusivity is a property of the request, not of the sizing, so it is settled here:
// a malformed order is turned away before it opens a transaction or looks anything up.
@ValidatorConstraint({ name: 'sizeOrAmount' })
class SizeOrAmount implements ValidatorConstraintInterface {
  validate(size: unknown, { object }: ValidationArguments): boolean {
    const { amount } = object as PlaceOrderDto;
    return size === undefined
      ? amount !== undefined
      : amount === undefined && isSize(size);
  }

  defaultMessage({ object }: ValidationArguments): string {
    const { size, amount } = object as PlaceOrderDto;
    return size !== undefined && amount === undefined
      ? `size must be a whole number of shares between 1 and ${MAX_INT4}`
      : 'send exactly one of size or amount';
  }
}

// Absence is spelled out rather than left to `@IsOptional()`, which waives the whole
// property for a null too — and a null amount is not an amount left out, it is a bad one.
@ValidatorConstraint({ name: 'money' })
class Money implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return value === undefined || isMoney(value);
  }

  defaultMessage({ property }: ValidationArguments): string {
    return `${property} must be between ${MIN_MONEY} and ${MAX_MONEY} with at most 2 decimals`;
  }
}

export class PlaceOrderDto {
  @IsInt()
  @IsPositive()
  @Max(MAX_INT4)
  userId!: number;

  @IsInt()
  @IsPositive()
  @Max(MAX_INT4)
  instrumentId!: number;

  @IsIn(SIDES)
  side!: Side;

  @IsIn(ORDER_TYPES)
  type!: OrderType;

  @Validate(LimitPrice)
  price?: number;

  @Validate(SizeOrAmount)
  size?: number;

  @Validate(Money)
  amount?: number;
}
