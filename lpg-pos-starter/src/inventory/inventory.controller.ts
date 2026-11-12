import { Controller, Get, Query } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { AuthUser, CurrentUser, scopeBranch } from '../auth/auth.guard';

@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Get()
  findAll(
    @CurrentUser() user: AuthUser,
    @Query('branchId') branchId?: string,
    @Query('search') search?: string,
    @Query('includeZero') includeZero?: string,
  ) {
    return this.inventoryService.findAll(
      scopeBranch(user, branchId),
      search,
      includeZero === 'true',
    );
  }

  @Get('movements')
  findMovements(
    @CurrentUser() user: AuthUser,
    @Query('branchId') branchId?: string,
    @Query('productId') productId?: string,
  ) {
    return this.inventoryService.findMovements(
      scopeBranch(user, branchId),
      productId,
    );
  }
}