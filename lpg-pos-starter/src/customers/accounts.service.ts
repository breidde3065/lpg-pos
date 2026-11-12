import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PaymentMethod, PaymentType, Prisma, SaleStatus } from '@prisma/client';
import { PrismaService } from '../prisma.service';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MPESA_CODE = /^[A-Z0-9]{8,12}$/;
const MAX_MONEY = 10_000_000;

const cents = (v: unknown) => Math.round(Number(v) * 100);
const rupees = (c: number) => Math.round(c) / 100;
const dec = (c: number) => new Prisma.Decimal((c / 100).toFixed(2));
const kes = (c: number) =>
  'KSh ' + String(Math.round(c / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

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

type LedgerSale = {
  id: string;
  customerId: string;
  saleNumber: string;
  createdAt: Date;
  branch: string;
  totalC: number;
  paidC: number;
  outstandingC: number;
};

// A payment counts only if it is a repayment, or it belongs to a completed sale.
const COUNTS = [{ saleId: null }, { sale: { status: SaleStatus.COMPLETED } }];

@Injectable()
export class AccountsService {
  constructor(private readonly prisma: PrismaService) {}

  // Every completed sale of the given customers, oldest first, with how much
  // of each is paid (at the time of sale, or later by a repayment).
  private async ledger(
    db: Prisma.TransactionClient,
    customerIds: string[],
  ): Promise<LedgerSale[]> {
    if (customerIds.length === 0) return [];

    const sales = await db.sale.findMany({
      where: {
        customerId: { in: customerIds },
        status: SaleStatus.COMPLETED,
      },
      select: {
        id: true,
        customerId: true,
        saleNumber: true,
        createdAt: true,
        total: true,
        branch: { select: { name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const ids = sales.map((s) => s.id);

    const [payments, allocations] = await Promise.all([
      db.payment.findMany({
        where: { saleId: { in: ids } },
        select: { saleId: true, amount: true },
      }),
      db.paymentAllocation.findMany({
        where: { saleId: { in: ids } },
        select: { saleId: true, amount: true },
      }),
    ]);

    const paid = new Map<string, number>();

    for (const p of [...payments, ...allocations]) {
      if (!p.saleId) continue;
      paid.set(p.saleId, (paid.get(p.saleId) ?? 0) + cents(p.amount));
    }

    return sales.map((s) => {
      const totalC = cents(s.total);
      const paidC = paid.get(s.id) ?? 0;

      return {
        id: s.id,
        customerId: s.customerId as string,
        saleNumber: s.saleNumber,
        createdAt: s.createdAt,
        branch: s.branch.name,
        totalC,
        paidC,
        outstandingC: Math.max(totalC - paidC, 0),
      };
    });
  }

  // Customers who owe money, biggest debt first.
  async credit(search?: string) {
    const [sold, paid] = await Promise.all([
      this.prisma.sale.groupBy({
        by: ['customerId'],
        where: { status: SaleStatus.COMPLETED, customerId: { not: null } },
        _sum: { total: true },
      }),
      this.prisma.payment.groupBy({
        by: ['customerId'],
        where: { customerId: { not: null }, OR: COUNTS },
        _sum: { amount: true },
      }),
    ]);

    // A quick first pass to find who might owe something...
    const net = new Map<string, number>();

    for (const r of sold) {
      if (r.customerId) net.set(r.customerId, cents(r._sum.total ?? 0));
    }

    for (const r of paid) {
      if (r.customerId) {
        net.set(r.customerId, (net.get(r.customerId) ?? 0) - cents(r._sum.amount ?? 0));
      }
    }

    const candidates = [...net.entries()].filter(([, c]) => c > 0).map(([id]) => id);

    // ...then the exact figures, sale by sale, for just those customers.
    const [customers, ledger] = await Promise.all([
      this.prisma.customer.findMany({ where: { id: { in: candidates } } }),
      this.ledger(this.prisma, candidates),
    ]);

    const rows = customers
      .map((c) => {
        const open = ledger.filter((s) => s.customerId === c.id && s.outstandingC > 0);

        return {
          id: c.id,
          name: c.name,
          phone: c.phone,
          outstandingC: open.reduce((n, s) => n + s.outstandingC, 0),
          openSales: open.length,
          oldestUnpaidAt: open[0]?.createdAt ?? null,
        };
      })
      .filter((r) => r.outstandingC > 0)
      .sort((a, b) => b.outstandingC - a.outstandingC);

    const term = search?.trim().toLowerCase();
    const shown = term
      ? rows.filter(
          (r) =>
            r.name.toLowerCase().includes(term) ||
            (r.phone ?? '').replace(/\s+/g, '').includes(term.replace(/\s+/g, '')),
        )
      : rows;

    return {
      // The totals always cover everyone who owes, even when a search is on.
      totals: {
        outstanding: rupees(rows.reduce((n, r) => n + r.outstandingC, 0)),
        customers: rows.length,
      },
      customers: shown.map(({ outstandingC, ...r }) => ({
        ...r,
        outstanding: rupees(outstandingC),
      })),
    };
  }

  // One customer's full account: what they owe and the history behind it.
  async account(customerId: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
    });

    if (!customer) throw new NotFoundException('Customer not found.');

    const ledger = await this.ledger(this.prisma, [customerId]);

    const payments = await this.prisma.payment.findMany({
      where: { customerId, OR: COUNTS },
      orderBy: { createdAt: 'desc' },
      take: 60,
      select: {
        id: true,
        createdAt: true,
        amount: true,
        method: true,
        reference: true,
        paymentType: true,
        branch: { select: { name: true } },
        recordedBy: { select: { name: true } },
        sale: { select: { saleNumber: true } },
      },
    });

    return {
      customer: {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        address: customer.address,
        notes: customer.notes,
      },
      outstanding: rupees(ledger.reduce((n, s) => n + s.outstandingC, 0)),
      sales: [...ledger]
        .reverse()
        .slice(0, 60)
        .map((s) => ({
          id: s.id,
          saleNumber: s.saleNumber,
          createdAt: s.createdAt,
          branch: s.branch,
          total: rupees(s.totalC),
          paid: rupees(s.paidC),
          outstanding: rupees(s.outstandingC),
        })),
      payments: payments.map((p) => ({
        id: p.id,
        createdAt: p.createdAt,
        amount: rupees(cents(p.amount)),
        method: p.method,
        reference: p.reference,
        kind: p.paymentType,
        branch: p.branch.name,
        recordedBy: p.recordedBy.name,
        saleNumber: p.sale?.saleNumber ?? null,
      })),
    };
  }

  // Records money a customer pays towards what they owe. It clears the
  // oldest debts first and writes everything in one all-or-nothing step.
  async repay(input: {
    customerId: string;
    branchId?: string;
    recordedById: string;
    amount?: unknown;
    method?: string;
    reference?: string;
    clientRef?: string;
  }) {
    const branchId = input.branchId?.trim();

    if (!branchId || !UUID.test(branchId)) {
      throw new BadRequestException('A branch is required to record a payment.');
    }

    const method = (input.method ?? '').toUpperCase();

    if (method !== 'CASH' && method !== 'MPESA_MANUAL') {
      throw new BadRequestException('Use CASH or MPESA_MANUAL.');
    }

    const amount = toMoney(input.amount, 'The payment amount');
    const amountC = cents(amount);
    let reference: string | null = null;

    if (method === 'MPESA_MANUAL') {
      reference = (input.reference ?? '').trim().toUpperCase();

      if (!MPESA_CODE.test(reference)) {
        throw new BadRequestException(
          'Enter the M-Pesa confirmation code (8 to 12 letters and numbers).',
        );
      }
    }

    const clientRef = input.clientRef?.trim();

    if (clientRef && !/^[A-Za-z0-9_-]{8,64}$/.test(clientRef)) {
      throw new BadRequestException('Invalid clientRef.');
    }

    const refNote = clientRef ? `ref:${clientRef}` : null;

    // A retried tap returns the payment that was already recorded.
    if (refNote) {
      const existing = await this.prisma.payment.findFirst({
        where: {
          recordedById: input.recordedById,
          paymentType: PaymentType.CUSTOMER_REPAYMENT,
          notes: refNote,
        },
        include: { allocations: { include: { sale: { select: { saleNumber: true } } } } },
      });

      if (existing) {
        const now = await this.account(input.customerId);

        return {
          payment: {
            id: existing.id,
            amount: rupees(cents(existing.amount)),
            method: existing.method,
            reference: existing.reference,
            createdAt: existing.createdAt,
          },
          allocations: existing.allocations.map((a) => ({
            saleNumber: a.sale.saleNumber,
            amount: rupees(cents(a.amount)),
          })),
          outstandingAfter: now.outstanding,
          replayed: true,
        };
      }
    }

    const [branch, customer] = await Promise.all([
      this.prisma.branch.findUnique({ where: { id: branchId } }),
      this.prisma.customer.findUnique({ where: { id: input.customerId } }),
    ]);

    if (!branch || !branch.isActive) {
      throw new NotFoundException('Branch not found or inactive.');
    }

    if (!customer) throw new NotFoundException('Customer not found.');

    return this.prisma.$transaction(async (tx) => {
      // Lock this customer's row so two payments for the same customer at
      // the same moment cannot both clear the same debt.
      await tx.$queryRaw`SELECT id FROM customers WHERE id = ${input.customerId}::uuid FOR UPDATE`;

      const open = (await this.ledger(tx, [input.customerId])).filter(
        (s) => s.outstandingC > 0,
      );
      const owed = open.reduce((n, s) => n + s.outstandingC, 0);

      if (owed <= 0) {
        throw new BadRequestException('This customer does not owe anything.');
      }

      if (amountC > owed) {
        throw new BadRequestException(
          `This customer only owes ${kes(owed)}. Enter that amount or less.`,
        );
      }

      if (reference) {
        const clash = await tx.payment.findFirst({
          where: {
            method: PaymentMethod.MPESA_MANUAL,
            reference: { equals: reference, mode: 'insensitive' },
          },
        });

        if (clash) {
          throw new ConflictException(
            `M-Pesa code ${reference} was already used on another payment.`,
          );
        }
      }

      const payment = await tx.payment.create({
        data: {
          branchId,
          customerId: input.customerId,
          saleId: null,
          paymentType: PaymentType.CUSTOMER_REPAYMENT,
          method: method as PaymentMethod,
          amount,
          reference,
          notes: refNote,
          recordedById: input.recordedById,
        },
      });

      const allocations: { saleNumber: string; amount: number }[] = [];
      let remaining = amountC;

      for (const s of open) {
        if (remaining <= 0) break;

        const part = Math.min(remaining, s.outstandingC);

        await tx.paymentAllocation.create({
          data: { paymentId: payment.id, saleId: s.id, amount: dec(part) },
        });

        allocations.push({ saleNumber: s.saleNumber, amount: rupees(part) });
        remaining -= part;
      }

      return {
        payment: {
          id: payment.id,
          amount: rupees(amountC),
          method,
          reference,
          createdAt: payment.createdAt,
        },
        allocations,
        outstandingAfter: rupees(owed - amountC),
        replayed: false,
      };
    });
  }
}