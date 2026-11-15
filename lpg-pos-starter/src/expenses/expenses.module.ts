import { Module } from '@nestjs/common';
import { ExpensesController } from './expenses.controller';
import { ExpensesService } from './expenses.service';
import { ProfitController } from './profit.controller';
import { ProfitService } from './profit.service';

@Module({
  controllers: [ExpensesController, ProfitController],
  providers: [ExpensesService, ProfitService],
})
export class ExpensesModule {}
