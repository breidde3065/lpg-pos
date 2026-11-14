import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import {
  CylinderStatus,
  StockMovementType,
} from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AuthUser } from '../auth/auth.guard';
type IntakeItemInput = {
  productId?: string;
  cylinderStatus?: string;
  quantity?: number;
};

type CreateIntakeInput = {
  branchId?: string;
  recordedById?: string;
  supplier?: string;
  deliveryRef?: string;
  notes?: string;
  items?: IntakeItemInput[];
};

@Injectable()
export class StockIntakeService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateIntakeInput) {
    const branchId = input.branchId?.trim();
    const recordedById = input.recordedById?.trim();

    if (!branchId || !recordedById) {
      throw new BadRequestException(
        'branchId and recordedById are required.',
      );
    }

    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new BadRequestException(
        'Add at least one item to the stock intake.',
      );
    }

    const items = input.items.map((item, index) => {
      const productId = item.productId?.trim();
      const status = (item.cylinderStatus ?? 'FULL').toUpperCase();
      const quantity = item.quantity;

      if (!productId) {
        throw new BadRequestException(
          `Item ${index + 1}: productId is required.`,
        );
      }

      if (
        !Object.values(CylinderStatus).includes(
          status as CylinderStatus,
        )
      ) {
        throw new BadRequestException(
          `Item ${index + 1}: status must be FULL or EMPTY.`,
        );
      }

      if (
        !Number.isSafeInteger(quantity) ||
        (quantity ?? 0) < 0
      ) {
        throw new BadRequestException(
          `Item ${index + 1}: quantity must be a  whole number, 0 or greater.`,
        );
      }

      return {
        productId,
        cylinderStatus: status as CylinderStatus,
        quantity: quantity as number,
      };
    });

    const uniqueProductIds = [
      ...new Set(items.map((item) => item.productId)),
    ];

    const [branch, user, products] = await Promise.all([
      this.prisma.branch.findUnique({
        where: { id: branchId },
      }),
      this.prisma.user.findUnique({
        where: { id: recordedById },
      }),
      this.prisma.product.findMany({
        where: {
          id: { in: uniqueProductIds },
          isActive: true,
        },
      }),
    ]);

    if (!branch || !branch.isActive) {
      throw new NotFoundException(
        'Branch not found or inactive.',
      );
    }

    if (
      !user ||
      !user.isActive ||
      user.status !== 'APPROVED'
    ) {
      throw new BadRequestException(
        'The receiving user must be active and approved.',
      );
    }

    if (products.length !== uniqueProductIds.length) {
      throw new NotFoundException(
        'One or more products were not found or are inactive.',
      );
    }

    const productsById = new Map(
      products.map((product) => [product.id, product]),
    );

    for (const item of items) {
      const product = productsById.get(item.productId)!;

      if (
        product.category !== 'LPG' &&
        item.cylinderStatus !== CylinderStatus.FULL
      ) {
        throw new BadRequestException(
          `Non-LPG product "${product.name}" must use status FULL.`,
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      
      
      const intake = await tx.stockIntake.create({
        data: {
          branchId,
          recordedById,
          supplier: input.supplier?.trim() || null,
          deliveryRef: input.deliveryRef?.trim() || null,
          notes: input.notes?.trim() || null,
        },
      });

      for (const item of items) {
        await tx.inventoryBalance.upsert({
          where: {
            branchId_productId_cylinderStatus: {
              branchId,
              productId: item.productId,
              cylinderStatus: item.cylinderStatus,
            },
          },
          create: {
            branchId,
            productId: item.productId,
            cylinderStatus: item.cylinderStatus,
            quantity: item.quantity,
          },
          update: {
            quantity: { increment: item.quantity },
          },
          
        });
                // A zero entry only registers the item; no history line needed.
        if (item.quantity === 0) continue;

        await tx.stockMovement.create({
          data: {
            branchId,
            productId: item.productId,
            intakeId: intake.id,
            cylinderStatus: item.cylinderStatus,
            quantityDelta: item.quantity,
            movementType: StockMovementType.RECEIPT,
            referenceType: 'STOCK_INTAKE',
            referenceId: intake.id,
            reason: input.deliveryRef?.trim() || 'Stock received',
            createdById: recordedById,
          },
        });
      }

      return tx.stockIntake.findUniqueOrThrow({
        where: { id: intake.id },
        include: {
          branch: true,
          recordedBy: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          movements: {
            include: {
              product: {
                include: { brand: true },
              },
            },
          },
        },
      });
    });
  }

  async undo(id: string, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const intake = await tx.stockIntake.findUnique({
        where: { id },
        include: {
          movements: { where: { movementType: StockMovementType.RECEIPT } },
        },
      });

      if (!intake) throw new NotFoundException('Stock intake not found.');

      if (user.role !== 'SUPER_USER' && intake.branchId !== user.branchId) {
        throw new ForbiddenException('You can only undo entries at your own branch.');
      }

      // Marks it undone; if two taps race, only one wins.
      const marked = await tx.stockIntake.updateMany({
        where: { id, voidedAt: null },
        data: { voidedAt: new Date(), voidedById: user.id },
      });

      if (marked.count === 0) {
        throw new BadRequestException('This entry was already undone.');
      }

      let belowZero = false;

      for (const m of intake.movements) {
        const where = {
          branchId: intake.branchId,
          productId: m.productId,
          cylinderStatus: m.cylinderStatus,
        };

        const balance = await tx.inventoryBalance.findFirst({ where });

        if ((balance?.quantity ?? 0) < m.quantityDelta) {
          if (user.role !== 'SUPER_USER') {
            throw new ConflictException(
              'Some of this stock has already been sold, so it cannot be undone here. Please ask the owner.',
            );
          }
          belowZero = true;
        }

        await tx.inventoryBalance.updateMany({
          where,
          data: { quantity: { decrement: m.quantityDelta } },
        });

        await tx.stockMovement.create({
          data: {
            branchId: intake.branchId,
            productId: m.productId,
            intakeId: intake.id,
            cylinderStatus: m.cylinderStatus,
            quantityDelta: -m.quantityDelta,
            movementType: StockMovementType.REVERSAL,
            referenceType: 'STOCK_INTAKE_UNDO',
            referenceId: intake.id,
            reason: 'Stock entry undone',
            createdById: user.id,
          },
        });
      }

      return { undone: true, belowZero };
    });
  }



  findAll(branchId?: string) {
    return this.prisma.stockIntake.findMany({
      where: {
        voidedAt: null,
        ...(branchId?.trim() ? { branchId: branchId.trim() } : {}),
      },
      include: {
        branch: true,
        recordedBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        _count: {
          select: { movements: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async findOne(id: string) {
    const intake = await this.prisma.stockIntake.findUnique({
      where: { id },
      include: {
        branch: true,
        recordedBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        movements: {
          include: {
            product: {
              include: { brand: true },
            },
          },
        },
      },
    });

    if (!intake) {
      throw new NotFoundException('Stock intake not found.');
    }

    return intake;
  }
}