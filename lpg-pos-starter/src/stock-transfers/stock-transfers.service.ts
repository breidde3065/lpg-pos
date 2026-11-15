import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CylinderStatus, StockMovementType, TransferStatus } from '@prisma/client';
import { AuthUser } from '../auth/auth.guard';
import { PrismaService } from '../prisma.service';

type CreateInput = {
  fromBranchId?: string;
  toBranchId?: string;
  notes?: string;
  items?: Array<{ productId?: string; cylinderStatus?: string; quantity?: number }>;
};

// Roomy limit so a slow connection never cancels a transfer half-way.
const TX = { maxWait: 10000, timeout: 20000 };

const transferInclude = {
  fromBranch: { select: { id: true, name: true } },
  toBranch: { select: { id: true, name: true } },
  sentBy: { select: { id: true, name: true } },
  receivedBy: { select: { id: true, name: true } },
  items: { include: { product: { include: { brand: true } } } },
};

@Injectable()
export class StockTransfersService {
  constructor(private readonly prisma: PrismaService) {}

  // Step 1: the sending branch hands stock over. Its stock drops now and the
  // transfer waits "in transit" until the other branch confirms.
  async create(input: CreateInput, user: AuthUser) {
    const fromBranchId = input.fromBranchId?.trim();
    const toBranchId = input.toBranchId?.trim();

    if (!fromBranchId) throw new BadRequestException('Choose the branch the stock is leaving.');
    if (!toBranchId) throw new BadRequestException('Choose the branch the stock is going to.');
    if (fromBranchId === toBranchId) throw new BadRequestException('Pick two different branches.');
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new BadRequestException('Add at least one item to the transfer.');
    }

    const merged = new Map<
      string,
      { productId: string; cylinderStatus: CylinderStatus; quantity: number }
    >();

    input.items.forEach((item, index) => {
      const productId = item.productId?.trim();
      const status = (item.cylinderStatus ?? 'FULL').toUpperCase();
      const quantity = item.quantity;

      if (!productId) throw new BadRequestException(`Item ${index + 1}: productId is required.`);
      if (!Object.values(CylinderStatus).includes(status as CylinderStatus)) {
        throw new BadRequestException(`Item ${index + 1}: status must be FULL or EMPTY.`);
      }
      if (!Number.isSafeInteger(quantity) || (quantity ?? 0) <= 0) {
        throw new BadRequestException(`Item ${index + 1}: quantity must be a positive whole number.`);
      }

      const key = `${productId}|${status}`;
      const existing = merged.get(key);
      if (existing) existing.quantity += quantity as number;
      else
        merged.set(key, {
          productId,
          cylinderStatus: status as CylinderStatus,
          quantity: quantity as number,
        });
    });

    const items = [...merged.values()];
    const productIds = [...new Set(items.map((i) => i.productId))];

    const [from, to, products] = await Promise.all([
      this.prisma.branch.findUnique({ where: { id: fromBranchId } }),
      this.prisma.branch.findUnique({ where: { id: toBranchId } }),
      this.prisma.product.findMany({ where: { id: { in: productIds }, isActive: true } }),
    ]);

    if (!from || !from.isActive || !to || !to.isActive) {
      throw new NotFoundException('Branch not found or inactive.');
    }
    if (products.length !== productIds.length) {
      throw new NotFoundException('One or more products were not found or are inactive.');
    }

    const byId = new Map(products.map((p) => [p.id, p]));

    for (const item of items) {
      const p = byId.get(item.productId)!;
      if (p.category !== 'LPG' && item.cylinderStatus !== CylinderStatus.FULL) {
        throw new BadRequestException(`"${p.name}" is not a cylinder, so it must use status FULL.`);
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const transfer = await tx.stockTransfer.create({
        data: {
          fromBranchId,
          toBranchId,
          sentById: user.id,
          notes: input.notes?.trim() || null,
          items: { create: items },
        },
      });

      for (const item of items) {
        // Takes the stock out only if enough is on record, in one safe step.
        const taken = await tx.inventoryBalance.updateMany({
          where: {
            branchId: fromBranchId,
            productId: item.productId,
            cylinderStatus: item.cylinderStatus,
            quantity: { gte: item.quantity },
          },
          data: { quantity: { decrement: item.quantity } },
        });

        if (taken.count === 0) {
          const p = byId.get(item.productId)!;
          throw new BadRequestException(
            `${from.name} does not have enough ${p.name} (${item.cylinderStatus.toLowerCase()}) to send.`,
          );
        }

        await tx.stockMovement.create({
          data: {
            branchId: fromBranchId,
            productId: item.productId,
            cylinderStatus: item.cylinderStatus,
            quantityDelta: -item.quantity,
            movementType: StockMovementType.TRANSFER_OUT,
            referenceType: 'STOCK_TRANSFER',
            referenceId: transfer.id,
            reason: `Sent to ${to.name}`,
            createdById: user.id,
          },
        });
      }

      return tx.stockTransfer.findUniqueOrThrow({
        where: { id: transfer.id },
        include: transferInclude,
      });
    }, TX);
  }

  // Step 2: the receiving branch confirms. Only now does its stock go up.
  async receive(id: string, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const transfer = await tx.stockTransfer.findUnique({
        where: { id },
        include: { items: true, fromBranch: { select: { name: true } } },
      });

      if (!transfer) throw new NotFoundException('Transfer not found.');

      if (user.role !== 'SUPER_USER' && user.branchId !== transfer.toBranchId) {
        throw new ForbiddenException('Only the receiving branch can confirm this transfer.');
      }

      // If two people tap at once, only one gets through.
      const marked = await tx.stockTransfer.updateMany({
        where: { id, status: TransferStatus.IN_TRANSIT },
        data: { status: TransferStatus.RECEIVED, receivedById: user.id, receivedAt: new Date() },
      });

      if (marked.count === 0) {
        throw new BadRequestException('This transfer was already confirmed or cancelled.');
      }

      for (const item of transfer.items) {
        await tx.inventoryBalance.upsert({
          where: {
            branchId_productId_cylinderStatus: {
              branchId: transfer.toBranchId,
              productId: item.productId,
              cylinderStatus: item.cylinderStatus,
            },
          },
          create: {
            branchId: transfer.toBranchId,
            productId: item.productId,
            cylinderStatus: item.cylinderStatus,
            quantity: item.quantity,
          },
          update: { quantity: { increment: item.quantity } },
        });

        await tx.stockMovement.create({
          data: {
            branchId: transfer.toBranchId,
            productId: item.productId,
            cylinderStatus: item.cylinderStatus,
            quantityDelta: item.quantity,
            movementType: StockMovementType.TRANSFER_IN,
            referenceType: 'STOCK_TRANSFER',
            referenceId: transfer.id,
            reason: `Received from ${transfer.fromBranch.name}`,
            createdById: user.id,
          },
        });
      }

      return tx.stockTransfer.findUniqueOrThrow({ where: { id }, include: transferInclude });
    }, TX);
  }

  // Either branch (or the owner) can cancel while it is still in transit.
  // The stock goes back to the sending branch.
  async cancel(id: string, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const transfer = await tx.stockTransfer.findUnique({
        where: { id },
        include: { items: true },
      });

      if (!transfer) throw new NotFoundException('Transfer not found.');

      if (
        user.role !== 'SUPER_USER' &&
        user.branchId !== transfer.fromBranchId &&
        user.branchId !== transfer.toBranchId
      ) {
        throw new ForbiddenException('You can only cancel transfers involving your branch.');
      }

      const marked = await tx.stockTransfer.updateMany({
        where: { id, status: TransferStatus.IN_TRANSIT },
        data: { status: TransferStatus.CANCELLED, cancelledById: user.id, cancelledAt: new Date() },
      });

      if (marked.count === 0) {
        throw new BadRequestException('This transfer was already confirmed or cancelled.');
      }

      for (const item of transfer.items) {
        await tx.inventoryBalance.upsert({
          where: {
            branchId_productId_cylinderStatus: {
              branchId: transfer.fromBranchId,
              productId: item.productId,
              cylinderStatus: item.cylinderStatus,
            },
          },
          create: {
            branchId: transfer.fromBranchId,
            productId: item.productId,
            cylinderStatus: item.cylinderStatus,
            quantity: item.quantity,
          },
          update: { quantity: { increment: item.quantity } },
        });

        await tx.stockMovement.create({
          data: {
            branchId: transfer.fromBranchId,
            productId: item.productId,
            cylinderStatus: item.cylinderStatus,
            quantityDelta: item.quantity,
            movementType: StockMovementType.REVERSAL,
            referenceType: 'STOCK_TRANSFER',
            referenceId: transfer.id,
            reason: 'Transfer cancelled',
            createdById: user.id,
          },
        });
      }

      return tx.stockTransfer.findUniqueOrThrow({ where: { id }, include: transferInclude });
    }, TX);
  }

  // Transfers involving a branch (or all branches, for the owner).
  list(branchId?: string, status?: string) {
    const where: any = {};

    if (branchId) where.OR = [{ fromBranchId: branchId }, { toBranchId: branchId }];

    const s = status?.toUpperCase();
    if (s && Object.values(TransferStatus).includes(s as TransferStatus)) where.status = s;

    return this.prisma.stockTransfer.findMany({
      where,
      include: transferInclude,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  // The running tally: confirmed cylinder transfers between each pair of
  // branches, netted per brand and size. Accessories are left out.
  async owed(branchId?: string) {
    const transfers = await this.prisma.stockTransfer.findMany({
      where: {
        status: TransferStatus.RECEIVED,
        ...(branchId ? { OR: [{ fromBranchId: branchId }, { toBranchId: branchId }] } : {}),
      },
      select: {
        fromBranchId: true,
        toBranchId: true,
        fromBranch: { select: { name: true } },
        toBranch: { select: { name: true } },
        items: {
          where: { product: { category: 'LPG' } },
          select: { productId: true, quantity: true, product: { select: { name: true } } },
        },
      },
    });

    type Row = {
      holderBranchId: string;
      holderBranchName: string;
      homeBranchId: string;
      homeBranchName: string;
      productId: string;
      productName: string;
      quantity: number;
    };

    // "holder" has cylinders that belong to "home".
    const held = new Map<string, Row>();

    for (const t of transfers) {
      for (const item of t.items) {
        const key = `${t.toBranchId}|${t.fromBranchId}|${item.productId}`;
        const row = held.get(key) || {
          holderBranchId: t.toBranchId,
          holderBranchName: t.toBranch.name,
          homeBranchId: t.fromBranchId,
          homeBranchName: t.fromBranch.name,
          productId: item.productId,
          productName: item.product.name,
          quantity: 0,
        };
        row.quantity += item.quantity;
        held.set(key, row);
      }
    }

    const result: Row[] = [];

    for (const row of held.values()) {
      const back = held.get(`${row.homeBranchId}|${row.holderBranchId}|${row.productId}`);
      const net = row.quantity - (back?.quantity ?? 0);
      if (net > 0) result.push({ ...row, quantity: net });
    }

    return result.sort((a, b) => b.quantity - a.quantity);
  }
}