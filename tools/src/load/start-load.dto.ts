import {
  ArrayNotEmpty,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { LoadMode } from './run';

const MODES: LoadMode[] = ['burst', 'ramp', 'contention'];

// The knobs `POST /load/run` may override; anything else the caller sends is stripped by the
// global whitelisting pipe. Every one left out keeps the last run's value.
export class StartLoadDto {
  @IsOptional()
  @IsIn(MODES)
  mode?: LoadMode;

  // The target sheds load only once a placement has waited its turn for longer than the
  // transaction it sits in is allowed to live, and on one box that takes a queue in the
  // thousands: a lower ceiling would leave the harness unable to reach the one behaviour
  // under contention the API actually documents.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3_000)
  concurrency?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5_000)
  totalOrders?: number;

  @IsOptional()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  @Min(1, { each: true })
  users?: number[];

  @IsOptional()
  @IsBoolean()
  sameInstrument?: boolean;

  // Half is the ceiling because a cancel needs a resting order to cancel: at a mix above a
  // half the plan would have no room left to place one.
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(0.5)
  cancelMix?: number;
}
