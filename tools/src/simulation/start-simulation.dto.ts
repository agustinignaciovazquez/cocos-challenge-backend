import {
  ArrayNotEmpty,
  IsInt,
  IsNumber,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

// The knobs `POST /simulation/start` may override; anything else the caller sends is
// stripped by the global whitelisting pipe, `running` included.
export class StartSimulationDto {
  @IsOptional()
  @IsNumber()
  @Min(0.1)
  @Max(50)
  ratePerSec?: number;

  @IsOptional()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  @Min(1, { each: true })
  users?: number[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  buyRatio?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  sizeMin?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  sizeMax?: number;
}
