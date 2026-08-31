import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { LoadService, LoadState } from './load.service';
import { RunResult } from './run';
import { StartLoadDto } from './start-load.dto';

@Controller('load')
export class LoadController {
  constructor(private readonly load: LoadService) {}

  // Answers with the run as it stands at its first instant: the run itself outlives the
  // request, and `GET /load/runs/:id` is where it is watched.
  @Post('run')
  run(@Body() overrides: StartLoadDto): RunResult {
    return this.load.start(overrides);
  }

  @Get('state')
  state(): LoadState {
    return this.load.state();
  }

  @Get('runs/:runId')
  result(@Param('runId') runId: string): RunResult {
    return this.load.result(runId);
  }
}
