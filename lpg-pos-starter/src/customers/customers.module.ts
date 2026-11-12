import { Module } from '@nestjs/common';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { AccountsService } from './accounts.service';

@Module({
  controllers: [CustomersController],
  providers: [CustomersService, AccountsService],
})
export class CustomersModule {}