import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, scopeBranch } from '../auth/auth.guard';
import { StockTransfersService } from './stock-transfers.service';

@Controller('stock-transfers')
export class StockTransfersController {
  constructor(private readonly service: StockTransfersService) {}

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body()
    body: {
      fromBranchId?: string;
      toBranchId?: string;
      notes?: string;
      items?: Array<{ productId?: string; cylinderStatus?: string; quantity?: number }>;
    },
  ) {
    return this.service.create(
      { ...body, fromBranchId: scopeBranch(user, body.fromBranchId) },
      user,
    );
  }

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('branchId') branchId?: string,
    @Query('status') status?: string,
  ) {
    return this.service.list(scopeBranch(user, branchId), status);
  }

  @Get('owed')
  owed(@CurrentUser() user: AuthUser, @Query('branchId') branchId?: string) {
    return this.service.owed(scopeBranch(user, branchId));
  }

  @Post(':id/receive')
  receive(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.receive(id, user);
  }

  @Post(':id/cancel')
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.cancel(id, user);
  }
}