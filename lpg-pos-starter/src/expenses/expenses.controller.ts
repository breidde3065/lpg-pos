import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../auth/auth.guard';
import { ExpensesService } from './expenses.service';

@Controller('expenses')
export class ExpensesController {
  constructor(private readonly service: ExpensesService) {}

  // ----- Categories -----

  @Get('categories')
  listCategories(@CurrentUser() user: AuthUser) {
    return this.service.listCategories(user);
  }

  @Post('categories')
  createCategory(@CurrentUser() user: AuthUser, @Body() body: { name?: string }) {
    return this.service.createCategory(body.name, user);
  }

  // ----- Stock purchases -----

  @Get('purchases')
  listPurchases(
    @CurrentUser() user: AuthUser,
    @Query('branchId') branchId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.service.listPurchases(user, branchId, from, to);
  }

  @Post('purchases')
  createPurchase(
    @CurrentUser() user: AuthUser,
    @Body()
    body: { branchId?: string; amount?: unknown; purchaseDate?: string; description?: string },
  ) {
    return this.service.createPurchase(body, user);
  }

  @Post('purchases/:id/void')
  voidPurchase(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.voidPurchase(id, user);
  }

  // ----- Shelf-stock value per month -----

  @Get('valuations')
  listValuations(@CurrentUser() user: AuthUser, @Query('branchId') branchId?: string) {
    return this.service.listValuations(user, branchId);
  }

  @Put('valuations')
  setValuation(
    @CurrentUser() user: AuthUser,
    @Body() body: { branchId?: string; month?: string; value?: unknown },
  ) {
    return this.service.setValuation(body, user);
  }

  // ----- Operating expenses -----

  @Get()
  listExpenses(
    @CurrentUser() user: AuthUser,
    @Query('branchId') branchId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.service.listExpenses(user, branchId, from, to);
  }

  @Post()
  createExpense(
    @CurrentUser() user: AuthUser,
    @Body()
    body: {
      branchId?: string;
      categoryId?: string;
      amount?: unknown;
      expenseDate?: string;
      description?: string;
    },
  ) {
    return this.service.createExpense(body, user);
  }

  @Post(':id/void')
  voidExpense(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.voidExpense(id, user);
  }
}
