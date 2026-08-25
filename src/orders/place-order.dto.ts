import {
  IsIn,
  IsInt,
  IsNumber,
  isNumber,
  IsOptional,
  IsPositive,
  isPositive,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { OrderType, ORDER_TYPES, Side, SIDES } from './order-rules';

@ValidatorConstraint({ name: 'limitPrice' })
class LimitPrice implements ValidatorConstraintInterface {
  validate(price: unknown, { object }: ValidationArguments): boolean {
    return (object as PlaceOrderDto).type === 'LIMIT'
      ? isNumber(price, { maxDecimalPlaces: 2 }) && isPositive(price)
      : price === undefined;
  }

  defaultMessage(): string {
    return 'price must be a positive amount on LIMIT orders and absent on MARKET orders';
  }
}

export class PlaceOrderDto {
  @IsInt()
  @IsPositive()
  userId!: number;

  @IsInt()
  @IsPositive()
  instrumentId!: number;

  @IsIn(SIDES)
  side!: Side;

  @IsIn(ORDER_TYPES)
  type!: OrderType;

  @Validate(LimitPrice)
  price?: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  size?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount?: number;
}
