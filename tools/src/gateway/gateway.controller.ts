import {
  All,
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  ParseIntPipe,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Attempt, AttemptsStore } from '../store/attempts.store';
import { GatewayService } from './gateway.service';

const PREFIX = '/api';
const DEFAULT_ATTEMPTS = 100;
const MAX_ATTEMPTS = 500;

@Controller()
export class GatewayController {
  constructor(
    private readonly gateway: GatewayService,
    private readonly attempts: AttemptsStore,
  ) {}

  @Get('attempts')
  recent(
    @Query('limit', new DefaultValuePipe(DEFAULT_ATTEMPTS), ParseIntPipe)
    limit: number,
  ): Attempt[] {
    return this.attempts.recent(Math.min(Math.max(limit, 0), MAX_ATTEMPTS));
  }

  // Everything under /api is forwarded verbatim so the web app's own trading calls are
  // measured by the same recorder the engine's are.
  @All(`${PREFIX}/*path`)
  async proxy(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<unknown> {
    // fetch refuses to carry a body on these two, so a client that sent one anyway would
    // otherwise be recorded as a transport failure of the target's making.
    const sent =
      request.method === 'GET' || request.method === 'HEAD' ? undefined : body;
    const result = await this.gateway.send(
      request.method,
      request.originalUrl.slice(PREFIX.length),
      sent,
    );

    // A transport failure has no status of its own; the caller asked a gateway for an
    // upstream answer and did not get one.
    response.status(result.status === 0 ? 502 : result.status);
    return result.body;
  }
}
