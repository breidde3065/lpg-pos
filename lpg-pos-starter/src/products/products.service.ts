import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ProductCategory } from '@prisma/client';
import { PrismaService } from '../prisma.service';

type CreateProductInput = {
  name?: string;
  sku?: string;
  category?: string;
  brandId?: string | null;
  cylinderSize?: string | null;
  variant?: string | null;
  unit?: string;
  sellingPrice?: number | string;
  exchangePrice?: number | string;
};

type UpdatePricesInput = {
  sellingPrice?: number | string | null;
  exchangePrice?: number | string | null;
};

// Turns what the app sends into a safe price (0 to 10,000,000, 2 decimals).
function toPrice(value: unknown, label: string): Prisma.Decimal {
  const bad = () =>
    new BadRequestException(`${label} must be a number from 0 to 10,000,000.`);

  if (typeof value === 'string') {
    if (!value.trim()) throw bad();
    value = Number(value.trim());
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) throw bad();
  if (value < 0 || value > 10_000_000) throw bad();

  return new Prisma.Decimal(value.toFixed(2));
}

// Matches text ignoring upper/lower case. A missing value matches "empty".
const sameText = (value: string | null) =>
  value === null
    ? null
    : { equals: value, mode: 'insensitive' as const };

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(search?: string, category?: string) {
    const term = search?.trim();
    const normalizedCategory = category?.trim().toUpperCase();

    if (
      normalizedCategory &&
      !Object.values(ProductCategory).includes(
        normalizedCategory as ProductCategory,
      )
    ) {
      throw new BadRequestException('Category must be LPG or MISC.');
    }

    return this.prisma.product.findMany({
      where: {
        isActive: true,
        ...(normalizedCategory
          ? { category: normalizedCategory as ProductCategory }
          : {}),
        ...(term
          ? {
              OR: [
                { name: { contains: term, mode: 'insensitive' } },
                { sku: { contains: term, mode: 'insensitive' } },
                {
                  brand: {
                    is: {
                      name: { contains: term, mode: 'insensitive' },
                    },
                  },
                },
              ],
            }
          : {}),
      },
      include: { brand: true },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });
  }

  async create(input: CreateProductInput) {
    const name = input.name?.trim();
    const sku = input.sku?.trim();

    if (!name) {
      throw new BadRequestException('Product name is required.');
    }

    if (!sku) {
      throw new BadRequestException('Product SKU/code is required.');
    }

    const category = (input.category ?? 'LPG').trim().toUpperCase();

    if (!Object.values(ProductCategory).includes(category as ProductCategory)) {
      throw new BadRequestException('Category must be LPG or MISC.');
    }

    const price = Number(input.sellingPrice ?? 0);

    if (!Number.isFinite(price) || price < 0) {
      throw new BadRequestException(
        'Selling price must be a valid non-negative number.',
      );
    }

    const exchange = Number(input.exchangePrice ?? 0);

    if (!Number.isFinite(exchange) || exchange < 0) {
      throw new BadRequestException(
        'Exchange price must be a valid non-negative number.',
      );
    }

    const brandId = input.brandId?.trim() || null;

    if (
      brandId &&
      !(await this.prisma.brand.findUnique({ where: { id: brandId } }))
    ) {
      throw new NotFoundException('Selected brand was not found.');
    }

    const cylinderSize = input.cylinderSize?.trim() || null;
    const variant = input.variant?.trim() || null;

    // If the same product is already registered, reuse it instead of
    // creating a duplicate that would split the stock count in two.
    //  - LPG: same brand + same cylinder size + same variant
    //  - MISC: same name + same variant
    const existing = await this.prisma.product.findFirst({
      where: {
        isActive: true,
        category: category as ProductCategory,
        ...(category === 'LPG'
          ? {
              brandId,
              cylinderSize: sameText(cylinderSize),
              variant: sameText(variant),
            }
          : {
              name: { equals: name, mode: 'insensitive' as const },
              variant: sameText(variant),
            }),
      },
      include: { brand: true },
    });

    if (existing) {
      return existing;
    }

    try {
      return await this.prisma.product.create({
        data: {
          name,
          sku,
          category: category as ProductCategory,
          brandId,
          cylinderSize,
          variant,
          unit: input.unit?.trim() || 'piece',
          sellingPrice: new Prisma.Decimal(price),
          exchangePrice: new Prisma.Decimal(category === 'LPG' ? exchange : 0),
        },
        include: { brand: true },
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'That SKU/code is already in use. Choose a unique SKU.',
        );
      }

      throw error;
    }
  }

  // Super User only (enforced in the controller): set a product's prices.
  //  - sellingPrice: the price of a full cylinder bought with the cylinder
  //    (or the price of a misc item).
  //  - exchangePrice: the price when the customer brings an empty (LPG only).
  async updatePrices(id: string, input: UpdatePricesInput) {
    const product = await this.prisma.product.findUnique({ where: { id } });

    if (!product || !product.isActive) {
      throw new NotFoundException('Product not found.');
    }

    const data: {
      sellingPrice?: Prisma.Decimal;
      exchangePrice?: Prisma.Decimal;
    } = {};

    if (input.sellingPrice !== undefined) {
      data.sellingPrice = toPrice(input.sellingPrice, 'Full cylinder price');
    }

    if (input.exchangePrice !== undefined) {
      if (product.category !== ProductCategory.LPG) {
        throw new BadRequestException(
          'Only LPG products have an exchange price.',
        );
      }

      data.exchangePrice = toPrice(input.exchangePrice, 'Exchange price');
    }

    if (Object.keys(data).length === 0) {
      throw new BadRequestException(
        'Send a sellingPrice and/or an exchangePrice.',
      );
    }

    return this.prisma.product.update({
      where: { id },
      data,
      include: { brand: true },
    });
  }
}