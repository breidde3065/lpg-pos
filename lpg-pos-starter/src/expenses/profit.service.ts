import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SaleStatus } from '@prisma/client';
import { PrismaService } from '../prisma.service';

export type ProfitPeriod = 'month' | 'quarter' | 'year';

const PERIODS: ProfitPeriod[] = ['month', 'quarter', 'year'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Same Nairobi-date rules as the Insights (reports) service, so revenue matches.
const OFFSET_MS = 3 * 60 * 60 * 1000;
const MONTH_FULL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const pad = (n: number) => String(n).padStart(2, '0');
const dayKey = (L: Date) => `${L.getUTCFullYear()}-${pad(L.getUTCMonth() + 1)}-${pad(L.getUTCDate())}`;
const monthKey = (L: Date) => `${L.getUTCFullYear()}-${pad(L.getUTCMonth() + 1)}`;
const monthName = (L: Date) => `${MONTH_FULL[L.getUTCMonth()]} ${L.getUTCFullYear()}`;
const firstOfMonth = (y: number, m0: number) => new Date(Date.UTC(y, m0, 1));
const toInstant = (L: Date) => new Date(L.getTime() - OFFSET_MS);
const localOf = (instant: Date) => {
  const t = new Date(instant.getTime() + OFFSET_MS);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
};
const cents = (v: unknown) => Math.round(Number(v ?? 0) * 100);
const rupees = (c: number) => Math.round(c) / 100;

function parseAnchor(raw?: string): Date {
  if (!raw) return localOf(new Date());

  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const bad = new BadRequestException('date must look like 2026-11-04.');

  if (!m) throw bad;

  const L = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (dayKey(L) !== raw || +m[1] < 2000 || +m[1] > 2100) throw bad;

  return L;
}

function rangeOf(period: ProfitPeriod, L: Date): { start: Date; end: Date } {
  const y = L.getUTCFullYear();
  const m = L.getUTCMonth();

  if (period === 'month') return { start: firstOfMonth(y, m), end: firstOfMonth(y, m + 1) };

  if (period === 'quarter') {
    const q = Math.floor(m / 3) * 3;
    return { start: firstOfMonth(y, q), end: firstOfMonth(y, q + 3) };
  }

  return { start: firstOfMonth(y, 0), end: firstOfMonth(y + 1, 0) };
}

function labelOf(period: ProfitPeriod, start: Date): string {
  if (period === 'month') return monthName(start);
  if (period === 'quarter') return `Q${Math.floor(start.getUTCMonth() / 3) + 1} ${start.getUTCFullYear()}`;
  return String(start.getUTCFullYear());
}

@Injectable()
export class ProfitService {
  constructor(private readonly prisma: PrismaService) {}

  // Profit = revenue - cost of goods sold - operating expenses, where
  // cost of goods sold = opening stock + stock purchases - closing stock.
  // If a needed shelf-stock value is missing, no profit figure is given.
  async profit(input: { period?: string; date?: string; branchId?: string }) {
    const period = (input.period ?? 'month') as ProfitPeriod;

    if (!PERIODS.includes(period)) {
      throw new BadRequestException(`period must be one of: ${PERIODS.join(', ')}.`);
    }

    const branchId = input.branchId?.trim() || undefined;

    if (branchId && !UUID.test(branchId)) {
      throw new BadRequestException('That branch is not valid.');
    }

    const anchor = parseAnchor(input.date?.trim());
    const { start, end } = rangeOf(period, anchor);

    // Shelf value at the end of the month BEFORE the period = opening stock.
    // Shelf value at the end of the LAST month of the period = closing stock.
    const openingMonth = firstOfMonth(start.getUTCFullYear(), start.getUTCMonth() - 1);
    const closingMonth = firstOfMonth(end.getUTCFullYear(), end.getUTCMonth() - 1);

    const branches = await this.prisma.branch.findMany({
      where: branchId ? { id: branchId } : { isActive: true },
      select: { id: true, name: true },
    });

    if (branchId && branches.length === 0) throw new NotFoundException('Branch not found.');

    const branchFilter = branchId ? { branchId } : {};

    const [revenueAgg, purchaseAgg, expenseGroups, valuations] = await Promise.all([
      this.prisma.sale.aggregate({
        _sum: { total: true },
        where: {
          status: SaleStatus.COMPLETED,
          createdAt: { gte: toInstant(start), lt: toInstant(end) },
          ...branchFilter,
        },
      }),
      this.prisma.stockPurchase.aggregate({
        _sum: { amount: true },
        where: { voidedAt: null, purchaseDate: { gte: start, lt: end }, ...branchFilter },
      }),
      this.prisma.expense.groupBy({
        by: ['categoryId'],
        _sum: { amount: true },
        where: { voidedAt: null, expenseDate: { gte: start, lt: end }, ...branchFilter },
      }),
      this.prisma.stockValuation.findMany({
        where: { month: { in: [openingMonth, closingMonth] }, ...branchFilter },
        select: { branchId: true, month: true, value: true },
      }),
    ]);

    const categories = await this.prisma.expenseCategory.findMany({
      where: { id: { in: expenseGroups.map((g) => g.categoryId) } },
      select: { id: true, name: true },
    });
    const categoryName = new Map(categories.map((c) => [c.id, c.name]));

    const byCategory = expenseGroups
      .map((g) => ({
        category: categoryName.get(g.categoryId) ?? 'Unknown',
        amount: cents(g._sum.amount),
      }))
      .sort((a, b) => b.amount - a.amount);

    const revenue = cents(revenueAgg._sum.total);
    const purchases = cents(purchaseAgg._sum.amount);
    const operatingExpenses = byCategory.reduce((sum, c) => sum + c.amount, 0);

    // Work out opening and closing shelf value, and what is still missing.
    const have = new Map(valuations.map((v) => [`${v.branchId}|${monthKey(v.month)}`, cents(v.value)]));
    const missing: string[] = [];
    let opening = 0;
    let closing = 0;

    for (const b of branches) {
      const o = have.get(`${b.id}|${monthKey(openingMonth)}`);
      const c = have.get(`${b.id}|${monthKey(closingMonth)}`);

      if (o === undefined) missing.push(`${b.name}: stock value at the end of ${monthName(openingMonth)}`);
      else opening += o;

      if (c === undefined) missing.push(`${b.name}: stock value at the end of ${monthName(closingMonth)}`);
      else closing += c;
    }

    const profitAvailable = branches.length > 0 && missing.length === 0;
    const warnings: string[] = [];

    let costOfGoodsSold: number | null = null;
    let grossProfit: number | null = null;
    let netProfit: number | null = null;

    if (profitAvailable) {
      costOfGoodsSold = opening + purchases - closing;
      grossProfit = revenue - costOfGoodsSold;
      netProfit = grossProfit - operatingExpenses;

      if (costOfGoodsSold < 0) {
        warnings.push(
          'Closing stock value is higher than opening stock plus purchases. Please check the stock values.',
        );
      }
    }

    return {
      period,
      label: labelOf(period, start),
      from: dayKey(start),
      toExclusive: dayKey(end),
      branchId: branchId ?? null,
      revenue: rupees(revenue),
      stockPurchases: rupees(purchases),
      operatingExpenses: {
        total: rupees(operatingExpenses),
        byCategory: byCategory.map((c) => ({ category: c.category, amount: rupees(c.amount) })),
      },
      profitAvailable,
      stock: profitAvailable ? { opening: rupees(opening), closing: rupees(closing) } : null,
      costOfGoodsSold: costOfGoodsSold === null ? null : rupees(costOfGoodsSold),
      grossProfit: grossProfit === null ? null : rupees(grossProfit),
      netProfit: netProfit === null ? null : rupees(netProfit),
      missing,
      warnings,
    };
  }
}
