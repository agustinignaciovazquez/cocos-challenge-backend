import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';
import { Portfolio, PortfolioService } from './portfolio.service';

@Controller('users')
export class PortfolioController {
  constructor(private readonly portfolio: PortfolioService) {}

  @Get(':id/portfolio')
  get(@Param('id', ParseIntPipe) userId: number): Promise<Portfolio> {
    return this.portfolio.forUser(userId);
  }
}
