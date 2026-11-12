import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ProductsService } from './products.service';
import { AuthUser, CurrentUser, Roles } from '../auth/auth.guard';

@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  findAll(
    @Query('search') search?: string,
    @Query('category') category?: string,
  ) {
    return this.productsService.findAll(search, category);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body()
    body: {
      name?: string;
      sku?: string;
      category?: string;
      brandId?: string | null;
      cylinderSize?: string | null;
      variant?: string | null;
      unit?: string;
      sellingPrice?: number | string;
      exchangePrice?: number | string;
    },
  ) {
    // Only a Super User may set prices. Cashiers register products at 0.
    const isOwner = user.role === 'SUPER_USER';

    return this.productsService.create({
      ...body,
      sellingPrice: isOwner ? body.sellingPrice : 0,
      exchangePrice: isOwner ? body.exchangePrice : 0,
    });
  }

  // Super User only: set the prices of one product.
  @Patch(':id/prices')
  @Roles('SUPER_USER')
  updatePrices(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body()
    body: {
      sellingPrice?: number | string | null;
      exchangePrice?: number | string | null;
    },
  ) {
    return this.productsService.updatePrices(id, body);
  }
}