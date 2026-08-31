import {
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { Page, RunCounts, RunManifest } from './history';
import { HistoryService } from './history.service';

const PAGE = 500;

@Controller('history')
export class HistoryController {
  constructor(private readonly history: HistoryService) {}

  @Get('runs')
  runs(): Promise<RunManifest[]> {
    return this.history.list();
  }

  @Get('runs/:runId')
  run(
    @Param('runId') runId: string,
  ): Promise<RunManifest & { counts: RunCounts }> {
    return this.history.run(runId);
  }

  @Get('runs/:runId/attempts')
  attempts(
    @Param('runId') runId: string,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @Query('limit', new DefaultValuePipe(PAGE), ParseIntPipe) limit: number,
  ): Promise<Page> {
    return this.history.rows(
      runId,
      Math.max(offset, 0),
      Math.min(Math.max(limit, 0), PAGE),
    );
  }
}
