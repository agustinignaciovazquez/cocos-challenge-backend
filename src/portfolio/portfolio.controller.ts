import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ParseIdPipe } from '../parse-id.pipe';
import { Portfolio, PortfolioService } from './portfolio.service';

@ApiTags('portfolio')
@Controller('users')
export class PortfolioController {
  constructor(private readonly portfolio: PortfolioService) {}

  @Get(':id/portfolio')
  get(@Param('id', ParseIdPipe) userId: number): Promise<Portfolio> {
    return this.portfolio.forUser(userId);
  }
}
