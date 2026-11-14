import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CylinderStatus,
  PaymentMethod,
  PaymentType,
  Prisma,
  ProductCategory,
  SaleStatus,
  SaleType,
  StockMovementType,
} from '@prisma/client';
import { PrismaService } from '../prisma.service';

type ProductWithBrand = Prisma.ProductGetPayload<{ include: { brand: true } }>;

type ItemInput = {
  productId?: string;
  quantity?: number;
  returnedProductId?: string;
};

type PaymentInput = {
  method?: string;
  amount?: number | string;
  reference?: string;
};

export type CreateSaleInput = {
  branchId?: string;
  createdById: string;
  saleType?: string;
  customerId?: string | null;
  items?: ItemInput[];
  payments?: PaymentInput[];
  clientRef?: string;
};

type Line = {
  product: ProductWithBrand;
  quantity: number;
  unitPrice: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
  returned: ProductWithBrand | null;
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MPESA_CODE = /^[A-Z0-9]{8,12}$/;
const MAX_MONEY = 10_000_000;

const SALE_INCLUDE = {
  items: { include: { product: { include: { brand: true } } } },
  payments: true,
  customer: true,
  branch: true,
  createdBy: { select: { id: true, name: true } },
} as const;

// A payment amount: a number above 0, at most 2 decimals.
function toMoney(value: unknown, label: string): Prisma.Decimal {
  const bad = () =>
    new BadRequestException(
      `${label} must be a number above 0 and up to 10,000,000.`,
    );

  if (typeof value === 'string') {
    if (!value.trim()) throw bad();
    value = Number(value.trim());
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) throw bad();
  if (value <= 0 || value > MAX_MONEY) throw bad();

  return new Prisma.Decimal(value.toFixed(2));
}

const sizeKey = (p: { cylinderSize: string | null }) =>
  (p.cylinderSize ?? '').trim().toLowerCase();

function isSaleNumberClash(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002' &&
    /sale_?number/i.test(JSON.stringify((error as any).meta ?? ''))
  );
}

@Injectable()
export class SalesService {
  constructor(private readonly prisma: PrismaService) {}

  // Records a completed sale in ONE all-or-nothing step: the sale, its
  // lines, the payments and the stock changes. Prices always come from the
  // database, never from the app.
  async create(input: CreateSaleInput) {
    const branchId = input.branchId?.trim();

    if (!branchId || !UUID.test(branchId)) {
      throw new BadRequestException('A branch is required to record a sale.');
    }

    const saleType = (input.saleType ?? '').toUpperCase();

    if (!['EXCHANGE', 'CYLINDER_SALE', 'OTHER'].includes(saleType)) {
      throw new BadRequestException(
        'Sale type must be EXCHANGE, CYLINDER_SALE or OTHER.',
      );
    }

    // Protects against a retried tap creating the same sale twice.
    const clientRef = input.clientRef?.trim();

    if (clientRef && !/^[A-Za-z0-9_-]{8,64}$/.test(clientRef)) {
      throw new BadRequestException('Invalid clientRef.');
    }

    const refNote = clientRef ? `ref:${clientRef}` : null;

    if (refNote) {
      const existing = await this.prisma.sale.findFirst({
        where: { createdById: input.createdById, notes: refNote },
        include: SALE_INCLUDE,
      });

      if (existing) {
        const paid = existing.payments.reduce(
          (sum, p) => sum.add(p.amount),
          new Prisma.Decimal(0),
        );

        return {
          ...existing,
          creditAmount: existing.total.sub(paid).toFixed(2),
          stockWarnings: [],
          returnedEmpties: [],
          replayed: true,
        };
      }
    }

    // ---- items ----
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new BadRequestException('Add at least one item to the sale.');
    }

    if (input.items.length > 50) {
      throw new BadRequestException('A sale can have at most 50 item lines.');
    }

    const merged = new Map<
      string,
      { productId: string; returnedProductId?: string; quantity: number }
    >();

    input.items.forEach((raw, i) => {
      const productId = raw.productId?.trim();
      const returnedProductId = raw.returnedProductId?.trim() || undefined;
      const quantity = raw.quantity;

      if (!productId || !UUID.test(productId)) {
        throw new BadRequestException(`Item ${i + 1}: choose a valid product.`);
      }

      if (returnedProductId && !UUID.test(returnedProductId)) {
        throw new BadRequestException(
          `Item ${i + 1}: the returned empty is not valid.`,
        );
      }

      if (
        typeof quantity !== 'number' ||
        !Number.isSafeInteger(quantity) ||
        quantity < 1 ||
        quantity > 1000
      ) {
        throw new BadRequestException(
          `Item ${i + 1}: quantity must be a whole number from 1 to 1000.`,
        );
      }

      const key = `${productId}|${returnedProductId ?? ''}`;
      const previous = merged.get(key);

      merged.set(key, {
        productId,
        returnedProductId,
        quantity: (previous?.quantity ?? 0) + quantity,
      });
    });

    const ids = new Set<string>();

    for (const m of merged.values()) {
      ids.add(m.productId);
      if (m.returnedProductId) ids.add(m.returnedProductId);
    }

    const [branch, found] = await Promise.all([
      this.prisma.branch.findUnique({ where: { id: branchId } }),
      this.prisma.product.findMany({
        where: { id: { in: [...ids] }, isActive: true },
        include: { brand: true },
      }),
    ]);

    if (!branch || !branch.isActive) {
      throw new NotFoundException('Branch not found or inactive.');
    }

    if (found.length !== ids.size) {
      throw new NotFoundException(
        'One or more products were not found or are inactive.',
      );
    }

    const byId = new Map(found.map((p) => [p.id, p]));
    const lines: Line[] = [];
    let gasLines = 0;

    for (const m of merged.values()) {
      const product = byId.get(m.productId)!;
      const isGas = product.category === ProductCategory.LPG;
      const exchanged = saleType === 'EXCHANGE' && isGas;

      if (isGas) gasLines += 1;

      if (m.returnedProductId && !exchanged) {
        throw new BadRequestException(
          'A returned empty only applies to an exchanged gas cylinder.',
        );
      }

      let returned: ProductWithBrand | null = null;

      if (exchanged) {
        returned = byId.get(m.returnedProductId ?? m.productId)!;

        if (
          returned.category !== ProductCategory.LPG ||
          sizeKey(returned) !== sizeKey(product)
        ) {
          throw new BadRequestException(
            `The returned empty must be a ${product.cylinderSize ?? 'matching'} gas cylinder.`,
          );
        }
      }

      const unitPrice = exchanged ? product.exchangePrice : product.sellingPrice;

      if (unitPrice.lte(0)) {
        throw new BadRequestException(
          `${product.name} has no ${exchanged ? 'exchange' : 'selling'} price yet. Ask the owner to set it.`,
        );
      }

      lines.push({
        product,
        quantity: m.quantity,
        unitPrice,
        lineTotal: unitPrice.mul(m.quantity),
        returned,
      });
    }

    if (saleType === 'OTHER' && gasLines > 0) {
      throw new BadRequestException(
        'Gas cylinders must be sold as an Exchange or a Full cylinder sale.',
      );
    }

    if (saleType !== 'OTHER' && gasLines === 0) {
      throw new BadRequestException(
        'An exchange or cylinder sale needs at least one gas cylinder.',
      );
    }

    const total = lines.reduce(
      (sum, l) => sum.add(l.lineTotal),
      new Prisma.Decimal(0),
    );

    // ---- payments (anything unpaid becomes credit) ----
    const rawPayments = input.payments ?? [];

    if (!Array.isArray(rawPayments) || rawPayments.length > 8) {
      throw new BadRequestException('Too many payments on one sale.');
    }

    const seenCodes = new Set<string>();

    const payments = rawPayments.map((p, i) => {
      const method = (p.method ?? '').toUpperCase();

      if (method !== 'CASH' && method !== 'MPESA_MANUAL') {
        throw new BadRequestException(
          `Payment ${i + 1}: use CASH or MPESA_MANUAL. Anything unpaid is recorded as credit.`,
        );
      }

      const amount = toMoney(p.amount, `Payment ${i + 1} amount`);
      let reference: string | null = null;

      if (method === 'MPESA_MANUAL') {
        reference = (p.reference ?? '').trim().toUpperCase();

        if (!MPESA_CODE.test(reference)) {
          throw new BadRequestException(
            `Payment ${i + 1}: enter the M-Pesa confirmation code (8 to 12 letters and numbers).`,
          );
        }

        if (seenCodes.has(reference)) {
          throw new BadRequestException(
            'The same M-Pesa code is used twice on this sale.',
          );
        }

        seenCodes.add(reference);
      }

      return { method: method as PaymentMethod, amount, reference };
    });

    const paid = payments.reduce(
      (sum, p) => sum.add(p.amount),
      new Prisma.Decimal(0),
    );

    if (paid.gt(total)) {
      throw new BadRequestException(
        'The payments add up to more than the sale total.',
      );
    }

    const credit = total.sub(paid);
    const customerId = input.customerId?.trim() || null;

    if (customerId) {
      if (!UUID.test(customerId)) {
        throw new BadRequestException('That customer is not valid.');
      }

      const customer = await this.prisma.customer.findUnique({
        where: { id: customerId },
      });

      if (!customer || !customer.isActive) {
        throw new NotFoundException('Customer not found.');
      }
    }

    if (credit.gt(0) && !customerId) {
      throw new BadRequestException(
        'Pick or add a customer: any unpaid amount is recorded as credit.',
      );
    }

    // ---- the all-or-nothing write ----
    const date = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Nairobi',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .format(new Date())
      .replace(/-/g, '');

    const prefix = `${branch.code}-${date}-`;

    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const count = await tx.sale.count({
            where: { saleNumber: { startsWith: prefix } },
          });

          const saleNumber = `${prefix}${String(count + 1).padStart(4, '0')}`;

          for (const p of payments) {
            if (!p.reference) continue;

            const clash = await tx.payment.findFirst({
              where: {
                method: PaymentMethod.MPESA_MANUAL,
                reference: { equals: p.reference, mode: 'insensitive' },
              },
            });

            if (clash) {
              throw new ConflictException(
                `M-Pesa code ${p.reference} was already used on another payment.`,
              );
            }
          }

          const sale = await tx.sale.create({
            data: {
              saleNumber,
              branchId,
              customerId,
              saleType: saleType as SaleType,
              status: SaleStatus.COMPLETED,
              subtotal: total,
              discount: new Prisma.Decimal(0),
              total,
              notes: refNote,
              createdById: input.createdById,
              items: {
                create: lines.map((l) => ({
                  productId: l.product.id,
                  quantity: l.quantity,
                  unitPrice: l.unitPrice,
                  lineTotal: l.lineTotal,
                })),
              },
            },
          });

          for (const p of payments) {
            await tx.payment.create({
              data: {
                branchId,
                customerId,
                saleId: sale.id,
                paymentType: PaymentType.SALE_PAYMENT,
                method: p.method,
                amount: p.amount,
                reference: p.reference,
                recordedById: input.createdById,
              },
            });
          }

          // Stock may go below zero (the depot chose to allow that with a
          // warning), so we record how short each item was.
          const stockWarnings: {
            productId: string;
            product: string;
            cylinderStatus: CylinderStatus;
            short: number;
          }[] = [];

          const move = async (
            product: ProductWithBrand,
            status: CylinderStatus,
            delta: number,
            type: StockMovementType,
          ) => {
            const key = {
              branchId_productId_cylinderStatus: {
                branchId,
                productId: product.id,
                cylinderStatus: status,
              },
            };

            if (delta < 0) {
              const current = await tx.inventoryBalance.findUnique({
                where: key,
              });
              const have = Math.max(current?.quantity ?? 0, 0);

              if (have < -delta) {
                stockWarnings.push({
                  productId: product.id,
                  product: product.name,
                  cylinderStatus: status,
                  short: -delta - have,
                });
              }
            }

            await tx.inventoryBalance.upsert({
              where: key,
              create: {
                branchId,
                productId: product.id,
                cylinderStatus: status,
                quantity: delta,
              },
              update: { quantity: { increment: delta } },
            });

            await tx.stockMovement.create({
              data: {
                branchId,
                productId: product.id,
                cylinderStatus: status,
                quantityDelta: delta,
                movementType: type,
                referenceType: 'SALE',
                referenceId: sale.id,
                reason: saleNumber,
                createdById: input.createdById,
              },
            });
          };

          for (const l of lines) {
            if (l.returned) {
              // Exchange: a full cylinder goes out, an empty comes in
              // (possibly of a different brand).
              await move(l.product, CylinderStatus.FULL, -l.quantity, StockMovementType.EXCHANGE);
              await move(l.returned, CylinderStatus.EMPTY, l.quantity, StockMovementType.EXCHANGE);
            } else {
              await move(l.product, CylinderStatus.FULL, -l.quantity, StockMovementType.SALE);
            }
          }

          const full = await tx.sale.findUniqueOrThrow({
            where: { id: sale.id },
            include: SALE_INCLUDE,
          });

          return {
            ...full,
            creditAmount: credit.toFixed(2),
            stockWarnings,
            returnedEmpties: lines
              .filter((l) => l.returned)
              .map((l) => ({
                product: l.returned!.name,
                quantity: l.quantity,
              })),
            replayed: false,
          };
        }, {maxWait: 10000, timeout: 20000});
      } catch (error) {
        // Two sales finished at the same moment and picked the same number.
        if (attempt < 4 && isSaleNumberClash(error)) continue;

        throw error;
      }
    }
  }
}