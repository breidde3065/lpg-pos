import { Body, Controller, Post } from '@nestjs/common';
import { SalesService } from './sales.service';
import { AuthUser, CurrentUser, scopeBranch } from '../auth/auth.guard';

@Controller('sales')
export class SalesController {
  constructor(private readonly salesService: SalesService) {}

  // Any signed-in user can record a sale. A cashier's sale always goes to
  // their own branch, and the sale is always recorded under their name.
  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body()
    body: {
      branchId?: string;
      saleType?: string;
      customerId?: string | null;
      items?: Array<{
        productId?: string;
        quantity?: number;
        returnedProductId?: string;
      }>;
      payments?: Array<{
        method?: string;
        amount?: number | string;
        reference?: string;
      }>;
      clientRef?: string;
    },
  ) {
    return this.salesService.create({
      branchId: scopeBranch(user, body.branchId),
      createdById: user.id,
      saleType: body.saleType,
      customerId: body.customerId,
      items: body.items,
      payments: body.payments,
      clientRef: body.clientRef,
    });
  }
}