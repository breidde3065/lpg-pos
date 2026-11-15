import { Controller, Get, Query } from '@nestjs/common';
import { Roles } from '../auth/auth.guard';
import { ProfitService } from './profit.service';

// Profit reports are for the owner only.
@Controller('profit')
@Roles('SUPER_USER')
export class ProfitController {
  constructor(private readonly profitService: ProfitService) {}

  // period:   month | quarter | year (default: month)
  // date:     any day inside the period you want (default: today), YYYY-MM-DD
  // branchId: leave out for the whole company
  @Get()
  profit(
    @Query('period') period?: string,
    @Query('date') date?: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.profitService.profit({ period, date, branchId });
  }
}
