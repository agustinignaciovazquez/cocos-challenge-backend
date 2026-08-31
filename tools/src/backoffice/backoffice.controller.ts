import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { AnomaliesStore, ANOMALIES_CAPACITY } from './anomalies.store';
import { Anomaly, DetectorConfig } from './anomaly';
import { BackofficeService, BackofficeStats } from './backoffice.service';
import { PatchConfigDto } from './patch-config.dto';
import { SimulationConfig } from '../simulation/simulation.service';

@Controller('backoffice')
export class BackofficeController {
  constructor(
    private readonly backoffice: BackofficeService,
    private readonly anomalies: AnomaliesStore,
  ) {}

  @Get('stats')
  stats(): Promise<BackofficeStats> {
    return this.backoffice.stats();
  }

  @Get('anomalies')
  async recent(
    @Query('limit', new DefaultValuePipe(ANOMALIES_CAPACITY), ParseIntPipe)
    limit: number,
  ): Promise<Anomaly[]> {
    await this.backoffice.sweep();
    return this.anomalies.recent(
      Math.min(Math.max(limit, 0), ANOMALIES_CAPACITY),
    );
  }

  @Patch('config')
  configure(
    @Body() patch: PatchConfigDto,
  ): Promise<{ config: DetectorConfig; simulation: SimulationConfig }> {
    return this.backoffice.configure(patch);
  }

  @Post('anomalies/clear')
  clear(): { cleared: number } {
    return { cleared: this.anomalies.clear() };
  }
}
