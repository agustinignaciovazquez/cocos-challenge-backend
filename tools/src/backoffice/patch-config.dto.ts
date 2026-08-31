import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { StartSimulationDto } from '../simulation/start-simulation.dto';

// The same simulation knobs a start request may override, plus the back-office's own
// threshold; anything else the caller sends is stripped by the global whitelisting pipe.
export class PatchConfigDto extends StartSimulationDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60_000)
  latencyThresholdMs?: number;
}
