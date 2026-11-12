import { Module } from '@nestjs/common';
import { StockIntakeController } from './stock-intake.controller';
import { StockIntakeService } from './stock-intake.service';

@Module({
  controllers: [StockIntakeController],
  providers: [StockIntakeService],
})
export class StockIntakeModule {}