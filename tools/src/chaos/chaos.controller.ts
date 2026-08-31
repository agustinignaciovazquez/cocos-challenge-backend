import { Body, Controller, Get, Post } from '@nestjs/common';
import { ChaosState } from './chaos';
import { ChaosConfigDto } from './chaos-config.dto';
import { ChaosService } from './chaos.service';

@Controller('chaos')
export class ChaosController {
  constructor(private readonly chaos: ChaosService) {}

  @Get('state')
  state(): ChaosState {
    return this.chaos.state();
  }

  // Answers with the state as it stands the instant the patch landed: a pause the patch just
  // started outlives the request, and `GET /chaos/state` is where it is watched.
  @Post('config')
  configure(@Body() patch: ChaosConfigDto): ChaosState {
    return this.chaos.configure(patch);
  }
}
