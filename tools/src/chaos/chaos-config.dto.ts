import { IsBoolean, IsIn, IsNumber, IsOptional, Min } from 'class-validator';
import { CHAOS_MODES, ChaosMode } from './chaos';

// One mode per call, patched onto what is already set: a body that omits `enabled` moves only
// the intensity, and one that omits `intensity` only the switch. The upper bound is left to
// the engine because every mode reads its intensity in a different unit.
export class ChaosConfigDto {
  @IsIn([...CHAOS_MODES])
  mode!: ChaosMode;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  intensity?: number;
}
