import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CustomersService } from './customers.service';
import { AccountsService } from './accounts.service';
import { AuthUser, CurrentUser, scopeBranch } from '../auth/auth.guard';

@Controller('customers')
export class CustomersController {
  constructor(
    private readonly customersService: CustomersService,
    private readonly accountsService: AccountsService,
  ) {}

  @Get()
  findAll(@Query('search') search?: string) {
    return this.customersService.findAll(search);
  }

  @Post()
  create(@Body() body: { name?: string; phone?: string }) {
    return this.customersService.create(body);
  }

  // Customers who owe money (shared across all branches).
  @Get('credit')
  credit(@Query('search') search?: string) {
    return this.accountsService.credit(search);
  }

  // One customer's account: what they owe, their sales and payments.
  @Get(':id/account')
  account(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.accountsService.account(id);
  }

  // Take a repayment. A cashier's payment is recorded at their own branch
  // and under their own name.
  @Post(':id/repayments')
  repay(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body()
    body: {
      branchId?: string;
      amount?: number | string;
      method?: string;
      reference?: string;
      clientRef?: string;
    },
  ) {
    return this.accountsService.repay({
      customerId: id,
      branchId: scopeBranch(user, body.branchId),
      recordedById: user.id,
      amount: body.amount,
      method: body.method,
      reference: body.reference,
      clientRef: body.clientRef,
    });
  }
}