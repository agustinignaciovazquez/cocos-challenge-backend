import { Transform, TransformFnParams } from 'class-transformer';
import { IsString, MinLength } from 'class-validator';

export class SearchInstrumentsDto {
  @Transform(({ value }: TransformFnParams): unknown =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  q!: string;
}
