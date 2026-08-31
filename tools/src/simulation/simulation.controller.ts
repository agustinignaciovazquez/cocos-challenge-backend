import { Body, Controller, Get, Post } from '@nestjs/common';
import { SimulationService, SimulationState } from './simulation.service';
import { StartSimulationDto } from './start-simulation.dto';

@Controller('simulation')
export class SimulationController {
  constructor(private readonly simulation: SimulationService) {}

  @Post('start')
  start(@Body() overrides: StartSimulationDto): Promise<SimulationState> {
    return this.simulation.start(overrides);
  }

  @Post('stop')
  stop(): SimulationState {
    return this.simulation.stop();
  }

  @Post('reset')
  reset(): Promise<SimulationState> {
    return this.simulation.reset();
  }

  @Get('state')
  state(): SimulationState {
    return this.simulation.state();
  }
}
