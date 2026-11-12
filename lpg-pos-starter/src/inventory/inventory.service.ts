import {
  BadRequestException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  // includeZero = false (default): only lines with stock, as before.
  // includeZero = true: also lines that have run out (used by the report).
  findAll(branchId?: string, search?: string, includeZero = false) {
    if (!branchId?.trim()) {
      throw new BadRequestException(
        'branchId is required to view branch inventory.',
      );
    }

    const term = search?.trim();

    return this.prisma.inventoryBalance.findMany({
      where: {
        branchId: branchId.trim(),
        ...(includeZero ? {} : { quantity: { gt: 0 } }),
        ...(term
          ? {
              product: {
                OR: [
                  {
                    name: {
                      contains: term,
                      mode: 'insensitive' as const,
                    },
                  },
                  {
                    sku: {
                      contains: term,
                      mode: 'insensitive' as const,
                    },
                  },
                  {
                    brand: {
                      is: {
                        name: {
                          contains: term,
                          mode: 'insensitive' as const,
                        },
                      },
                    },
                  },
                ],
              },
            }
          : {}),
      },
      include: {
        product: {
          include: { brand: true },
        },
        branch: true,
      },
      orderBy: [
        { product: { category: 'asc' } },
        { product: { name: 'asc' } },
        { cylinderStatus: 'asc' },
      ],
    });
  }

  findMovements(branchId?: string, productId?: string) {
    if (!branchId?.trim()) {
      throw new BadRequestException(
        'branchId is required to view stock movements.',
      );
    }

    return this.prisma.stockMovement.findMany({
      where: {
        branchId: branchId.trim(),
        ...(productId ? { productId } : {}),
      },
      include: {
        product: {
          include: { brand: true },
        },
        createdBy: {
          select: { id: true, name: true },
        },
        intake: {
          select: {
            id: true,
            supplier: true,
            deliveryRef: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }
}