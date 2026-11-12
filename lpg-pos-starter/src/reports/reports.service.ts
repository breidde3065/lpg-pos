import { BadRequestException, Injectable } from '@nestjs/common';
import { CylinderStatus, Prisma, SaleStatus, StockMovementType } from '@prisma/client';
import { PrismaService } from '../prisma.service';

export type Period = 'day' | 'week' | 'month' | 'quarter' | 'half' | 'year';

const PERIODS: Period[] = ['day', 'week', 'month', 'quarter', 'half', 'year'];
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Kenya is UTC+3 all year (no daylight saving). A "local date" is stored as
// a Date at midnight UTC that stands for that calendar day in Nairobi.
const OFFSET_MS = 3 * 60 * 60 * 1000;
const MAX_SALES = 100_000;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const pad = (n: number) => String(n).padStart(2, '0');
const dayKey = (L: Date) => `${L.getUTCFullYear()}-${pad(L.getUTCMonth() + 1)}-${pad(L.getUTCDate())}`;
const monthKey = (L: Date) => `${L.getUTCFullYear()}-${pad(L.getUTCMonth() + 1)}`;
const addDays = (L: Date, n: number) => new Date(L.getTime() + n * 86_400_000);
const firstOfMonth = (y: number, m0: number) => new Date(Date.UTC(y, m0, 1));
const weekStart = (L: Date) => addDays(L, -((L.getUTCDay() + 6) % 7)); // Monday
const toInstant = (L: Date) => new Date(L.getTime() - OFFSET_MS);
const localOf = (instant: Date) => {
  const t = new Date(instant.getTime() + OFFSET_MS);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
};
const cents = (v: unknown) => Math.round(Number(v) * 100);
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

function rangeOf(period: Period, L: Date): { start: Date; end: Date } {
  const y = L.getUTCFullYear();
  const m = L.getUTCMonth();

  switch (period) {
    case 'day':
      return { start: L, end: addDays(L, 1) };
    case 'week': {
      const s = weekStart(L);
      return { start: s, end: addDays(s, 7) };
    }
    case 'month':
      return { start: firstOfMonth(y, m), end: firstOfMonth(y, m + 1) };
    case 'quarter': {
      const q = Math.floor(m / 3) * 3;
      return { start: firstOfMonth(y, q), end: firstOfMonth(y, q + 3) };
    }
    case 'half': {
      const h = m < 6 ? 0 : 6;
      return { start: firstOfMonth(y, h), end: firstOfMonth(y, h + 6) };
    }
    default:
      return { start: firstOfMonth(y, 0), end: firstOfMonth(y + 1, 0) };
  }
}

function labelOf(period: Period, start: Date, end: Date): string {
  const y = start.getUTCFullYear();
  const last = addDays(end, -1);

  switch (period) {
    case 'day':
      return `${DOW[start.getUTCDay()]} ${start.getUTCDate()} ${MON[start.getUTCMonth()]} ${y}`;
    case 'week':
      return `${start.getUTCDate()} ${MON[start.getUTCMonth()]} – ${last.getUTCDate()} ${MON[last.getUTCMonth()]} ${last.getUTCFullYear()}`;
    case 'month':
      return `${MONTH_FULL[start.getUTCMonth()]} ${y}`;
    case 'quarter':
      return `Q${Math.floor(start.getUTCMonth() / 3) + 1} ${y}`;
    case 'half':
      return `${start.getUTCMonth() < 6 ? 'H1' : 'H2'} ${y}`;
    default:
      return String(y);
  }
}

// The chart buckets: days for a week or month, weeks for a quarter,
// months for half a year or a year. (A single day has no chart.)
function bucketsOf(period: Period, start: Date, end: Date) {
  const list: { key: string; label: string }[] = [];
  let keyOf: (L: Date) => string = dayKey;

  if (period === 'week' || period === 'month') {
    for (let d = start; d < end; d = addDays(d, 1)) {
      list.push({
        key: dayKey(d),
        label: period === 'week' ? DOW[d.getUTCDay()] : String(d.getUTCDate()),
      });
    }
  } else if (period === 'quarter') {
    for (let d = weekStart(start); d < end; d = addDays(d, 7)) {
      list.push({ key: dayKey(d), label: `${d.getUTCDate()} ${MON[d.getUTCMonth()]}` });
    }
    keyOf = (L) => dayKey(weekStart(L));
  } else if (period === 'half' || period === 'year') {
    for (let d = start; d < end; d = firstOfMonth(d.getUTCFullYear(), d.getUTCMonth() + 1)) {
      list.push({ key: monthKey(d), label: MON[d.getUTCMonth()] });
    }
    keyOf = monthKey;
  }

  return { list, keyOf };
}

const SALE_SELECT = {
  id: true,
  saleNumber: true,
  createdAt: true,
  total: true,
  saleType: true,
  branch: { select: { name: true } },
  createdBy: { select: { name: true } },
  customer: { select: { name: true } },
  items: {
    select: {
      quantity: true,
      lineTotal: true,
      product: {
        select: {
          id: true,
          name: true,
          category: true,
          cylinderSize: true,
          brand: { select: { name: true } },
        },
      },
    },
  },
  payments: { select: { method: true, amount: true } },
} as const;

type SaleRow = Prisma.SaleGetPayload<{ select: typeof SALE_SELECT }>;

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  private loadSales(from: Date, to: Date, branchId?: string) {
    return this.prisma.sale.findMany({
      where: {
        status: SaleStatus.COMPLETED,
        createdAt: { gte: from, lt: to },
        ...(branchId ? { branchId } : {}),
      },
      select: SALE_SELECT,
      orderBy: { createdAt: 'desc' },
      take: MAX_SALES + 1,
    });
  }

  private totalsOf(sales: SaleRow[]) {
    let revenue = 0;
    let units = 0;

    for (const s of sales) {
      revenue += cents(s.total);
      for (const i of s.items) units += i.quantity;
    }

    return { sales: sales.length, revenue: rupees(revenue), units };
  }

  // What happened to sales (and stock) over one period, for the owner's
  // Insights screen. All dates are Nairobi dates.
  async sales(input: { period?: string; date?: string; branchId?: string }) {
    const period = (input.period ?? 'month') as Period;

    if (!PERIODS.includes(period)) {
      throw new BadRequestException(`period must be one of: ${PERIODS.join(', ')}.`);
    }

    const branchId = input.branchId?.trim() || undefined;

    if (branchId && !UUID.test(branchId)) {
      throw new BadRequestException('That branch is not valid.');
    }

    const anchor = parseAnchor(input.date?.trim());
    const { start, end } = rangeOf(period, anchor);
    const from = toInstant(start);
    const to = toInstant(end);
    const today = localOf(new Date());
    const containsToday = today >= start && today < end;

    const prevRange = rangeOf(period, addDays(start, -1));

    const [sales, movements, prevSales] = await Promise.all([
      this.loadSales(from, to, branchId),
      this.prisma.stockMovement.findMany({
        where: {
          movementType: StockMovementType.RECEIPT,
          cylinderStatus: CylinderStatus.FULL,
          createdAt: { gte: from, lt: to },
          ...(branchId ? { branchId } : {}),
        },
        select: { createdAt: true, quantityDelta: true },
      }),
      this.loadSales(toInstant(prevRange.start), toInstant(prevRange.end), branchId),
    ]);

    if (sales.length > MAX_SALES || prevSales.length > MAX_SALES) {
      throw new BadRequestException('Too many sales in that period. Pick a shorter period.');
    }

    const { list, keyOf } = bucketsOf(period, start, end);
    const series = new Map(
      list.map((b) => [b.key, { key: b.key, label: b.label, revenue: 0, units: 0, sales: 0, received: 0 }]),
    );

    const products = new Map<string, { id: string; name: string; brand: string; size: string; category: string; units: number; revenue: number }>();
    const brands = new Map<string, { units: number; revenue: number }>();
    const sizes = new Map<string, { units: number; revenue: number }>();
    const types = new Map<string, { sales: number; revenue: number }>();
    const branches = new Map<string, { sales: number; units: number; revenue: number }>();

    let revenue = 0;
    let units = 0;
    let cash = 0;
    let mpesa = 0;
    let exchangedEmpties = 0;

    for (const s of sales) {
      const total = cents(s.total);
      const bucket = series.get(keyOf(localOf(s.createdAt)));
      let saleUnits = 0;

      revenue += total;

      for (const i of s.items) {
        const p = i.product;
        const line = cents(i.lineTotal);
        const isGas = p.category === 'LPG';
        const brandName = p.brand?.name ?? (isGas ? 'Unidentified' : 'Accessories');
        const sizeName = isGas ? p.cylinderSize || 'Unsized' : 'Accessories';

        saleUnits += i.quantity;

        const prod = products.get(p.id) ?? { id: p.id, name: p.name, brand: brandName, size: sizeName, category: p.category, units: 0, revenue: 0 };
        prod.units += i.quantity;
        prod.revenue += line;
        products.set(p.id, prod);

        const b = brands.get(brandName) ?? { units: 0, revenue: 0 };
        b.units += i.quantity;
        b.revenue += line;
        brands.set(brandName, b);

        const z = sizes.get(sizeName) ?? { units: 0, revenue: 0 };
        z.units += i.quantity;
        z.revenue += line;
        sizes.set(sizeName, z);

        if (s.saleType === 'EXCHANGE' && isGas) exchangedEmpties += i.quantity;
      }

      units += saleUnits;

      for (const p of s.payments) {
        if (p.method === 'CASH') cash += cents(p.amount);
        if (p.method === 'MPESA_MANUAL') mpesa += cents(p.amount);
      }

      const t = types.get(s.saleType) ?? { sales: 0, revenue: 0 };
      t.sales += 1;
      t.revenue += total;
      types.set(s.saleType, t);

      const br = branches.get(s.branch.name) ?? { sales: 0, units: 0, revenue: 0 };
      br.sales += 1;
      br.units += saleUnits;
      br.revenue += total;
      branches.set(s.branch.name, br);

      if (bucket) {
        bucket.revenue += total;
        bucket.units += saleUnits;
        bucket.sales += 1;
      }
    }

    let received = 0;

    for (const m of movements) {
      received += m.quantityDelta;
      const bucket = series.get(keyOf(localOf(m.createdAt)));
      if (bucket) bucket.received += m.quantityDelta;
    }

    const byRevenue = <T extends { revenue: number }>(a: T, b: T) => b.revenue - a.revenue;
    const money = <T extends { revenue: number }>(x: T) => ({ ...x, revenue: rupees(x.revenue) });

    return {
      period,
      label: labelOf(period, start, end),
      from: dayKey(start),
      toExclusive: dayKey(end),
      containsToday,
      anchors: { prev: dayKey(addDays(start, -1)), next: containsToday ? null : dayKey(end) },
      branchId: branchId ?? null,
      totals: {
        sales: sales.length,
        revenue: rupees(revenue),
        units,
        cash: rupees(cash),
        mpesa: rupees(mpesa),
        credit: rupees(Math.max(revenue - cash - mpesa, 0)),
        exchangedEmpties,
        received,
      },
      previous: this.totalsOf(prevSales),
      series: [...series.values()].map((b) => ({ ...b, revenue: rupees(b.revenue) })),
      products: [...products.values()].sort(byRevenue).slice(0, 50).map(money),
      brands: [...brands.entries()].map(([name, v]) => money({ name, ...v })).sort(byRevenue),
      sizes: [...sizes.entries()].map(([name, v]) => money({ name, ...v })).sort(byRevenue),
      types: [...types.entries()].map(([type, v]) => money({ type, ...v })).sort(byRevenue),
      branches: [...branches.entries()].map(([name, v]) => money({ name, ...v })).sort(byRevenue),
      recent: sales.slice(0, 30).map((s) => ({
        id: s.id,
        saleNumber: s.saleNumber,
        createdAt: s.createdAt,
        total: rupees(cents(s.total)),
        saleType: s.saleType,
        branch: s.branch.name,
        cashier: s.createdBy.name,
        customer: s.customer?.name ?? null,
      })),
    };
  }
}