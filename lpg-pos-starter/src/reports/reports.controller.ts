import { Controller, Get, Query } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { Roles } from '../auth/auth.guard';

// Sales reports are for the owner only.
@Controller('reports')
@Roles('SUPER_USER')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  // period: day | week | month | quarter | half | year
  // date:   any day inside the period you want (default: today), YYYY-MM-DD
  // branchId: leave out for all branches
  @Get('sales')
  sales(
    @Query('period') period?: string,
    @Query('date') date?: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.reportsService.sales({ period, date, branchId });
  }
}