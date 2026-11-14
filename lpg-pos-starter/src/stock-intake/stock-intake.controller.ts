import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { StockIntakeService } from './stock-intake.service';
import { AuthUser, CurrentUser, scopeBranch } from '../auth/auth.guard';

@Controller('stock-intake')
export class StockIntakeController {
  constructor(private readonly stockIntakeService: StockIntakeService) {}

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body()
    body: {
      branchId?: string;
      recordedById?: string;
      supplier?: string;
      deliveryRef?: string;
      notes?: string;
      items?: Array<{
        productId?: string;
        cylinderStatus?: string;
        quantity?: number;
      }>;
    },
  ) {
    // The branch is checked against the signed-in person, and the
    // "recorded by" name is always the signed-in person, whatever the
    // app sends.
    return this.stockIntakeService.create({
      ...body,
      branchId: scopeBranch(user, body.branchId),
      recordedById: user.id,
    });
  }

  @Get()
  findAll(@CurrentUser() user: AuthUser, @Query('branchId') branchId?: string) {
    return this.stockIntakeService.findAll(scopeBranch(user, branchId));
  }

  @Post(':id/undo')
  undo(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.stockIntakeService.undo(id, user);
  }

  @Get(':id')
  async findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const intake = await this.stockIntakeService.findOne(id);

    if (user.role !== 'SUPER_USER' && intake.branchId !== user.branchId) {
      throw new ForbiddenException('You can only view your own branch.');
    }

    return intake;
  }
}