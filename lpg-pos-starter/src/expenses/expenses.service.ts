import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuthUser } from '../auth/auth.guard';
import { PrismaService } from '../prisma.service';

const DEFAULT_CATEGORIES = ['Rent', 'Wages', 'Transport', 'Electricity'];

// Only the owner may touch anything in this module.
function requireOwner(user: AuthUser) {
  if (user.role !== 'SUPER_USER') {
    throw new ForbiddenException('Only the owner can do this.');
  }
}

// Accepts a number such as 120000 or 1500.5 (max 2 decimal places).
function parseAmount(value: unknown, allowZero = false): number {
  const n = typeof value === 'string' ? Number(value) : (value as number);
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new BadRequestException('Enter the amount as a number.');
  }
  if (allowZero ? n < 0 : n <= 0) {
    throw new BadRequestException(
      allowZero ? 'Amount cannot be negative.' : 'Amount must be more than zero.',
    );
  }
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) {
    throw new BadRequestException('Amount can have at most 2 decimal places.');
  }
  return n;
}

// Accepts "YYYY-MM-DD" and returns a Date at midnight UTC.
function parseDate(value: unknown, label: string): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BadRequestException(`${label} must look like 2026-11-15.`);
  }
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new BadRequestException(`${label} is not a real date.`);
  }
  return d;
}

// Any date inside a month becomes the 1st of that month.
function monthStart(value: unknown): Date {
  const d = parseDate(value, 'Month');
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function dateRange(from?: string, to?: string) {
  if (!from && !to) return undefined;
  return {
    ...(from ? { gte: parseDate(from, 'From date') } : {}),
    ...(to ? { lte: parseDate(to, 'To date') } : {}),
  };
}

@Injectable()
export class ExpensesService {
  constructor(private readonly prisma: PrismaService) {}

  private async requireActiveBranch(branchId: string) {
    const branch = await this.prisma.branch.findUnique({ where: { id: branchId } });
    if (!branch || !branch.isActive) throw new NotFoundException('Branch not found or inactive.');
    return branch;
  }

  // ---------- Categories ----------

  async listCategories(user: AuthUser) {
    requireOwner(user);

    // First time only: add the four starting categories.
    const count = await this.prisma.expenseCategory.count();
    if (count === 0) {
      await this.prisma.expenseCategory.createMany({
        data: DEFAULT_CATEGORIES.map((name) => ({ name })),
        skipDuplicates: true,
      });
    }

    return this.prisma.expenseCategory.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  async createCategory(name: string | undefined, user: AuthUser) {
    requireOwner(user);

    const clean = name?.trim();
    if (!clean) throw new BadRequestException('Enter a category name.');

    const existing = await this.prisma.expenseCategory.findUnique({ where: { name: clean } });
    if (existing) {
      if (existing.isActive) throw new BadRequestException('That category already exists.');
      return this.prisma.expenseCategory.update({
        where: { id: existing.id },
        data: { isActive: true },
      });
    }

    return this.prisma.expenseCategory.create({ data: { name: clean } });
  }

  // ---------- Operating expenses (rent, wages, ...) ----------

  async createExpense(
    input: {
      branchId?: string;
      categoryId?: string;
      amount?: unknown;
      expenseDate?: string;
      description?: string;
    },
    user: AuthUser,
  ) {
    requireOwner(user);

    const amount = parseAmount(input.amount);
    const expenseDate = parseDate(input.expenseDate, 'Expense date');

    const categoryId = input.categoryId?.trim();
    if (!categoryId) throw new BadRequestException('Choose a category.');
    const category = await this.prisma.expenseCategory.findUnique({ where: { id: categoryId } });
    if (!category || !category.isActive) throw new NotFoundException('Category not found.');

    // Empty branch means "whole company".
    const branchId = input.branchId?.trim() || null;
    if (branchId) await this.requireActiveBranch(branchId);

    return this.prisma.expense.create({
      data: {
        branchId,
        categoryId,
        amount,
        expenseDate,
        description: input.description?.trim() || null,
        recordedById: user.id,
      },
      include: { category: true, branch: { select: { id: true, name: true } } },
    });
  }

  async listExpenses(user: AuthUser, branchId?: string, from?: string, to?: string) {
    requireOwner(user);

    return this.prisma.expense.findMany({
      where: {
        voidedAt: null,
        ...(branchId ? { branchId } : {}),
        ...(from || to ? { expenseDate: dateRange(from, to) } : {}),
      },
      include: { category: true, branch: { select: { id: true, name: true } } },
      orderBy: { expenseDate: 'desc' },
      take: 200,
    });
  }

  async voidExpense(id: string, user: AuthUser) {
    requireOwner(user);

    const done = await this.prisma.expense.updateMany({
      where: { id, voidedAt: null },
      data: { voidedAt: new Date(), voidedById: user.id },
    });
    if (done.count === 0) throw new NotFoundException('Expense not found or already voided.');
    return { id, voided: true };
  }

  // ---------- Stock purchases (money paid for a delivery) ----------

  async createPurchase(
    input: { branchId?: string; amount?: unknown; purchaseDate?: string; description?: string },
    user: AuthUser,
  ) {
    requireOwner(user);

    const amount = parseAmount(input.amount);
    const purchaseDate = parseDate(input.purchaseDate, 'Purchase date');

    const branchId = input.branchId?.trim();
    if (!branchId) throw new BadRequestException('Choose the branch this stock was bought for.');
    await this.requireActiveBranch(branchId);

    return this.prisma.stockPurchase.create({
      data: {
        branchId,
        amount,
        purchaseDate,
        description: input.description?.trim() || null,
        recordedById: user.id,
      },
      include: { branch: { select: { id: true, name: true } } },
    });
  }

  async listPurchases(user: AuthUser, branchId?: string, from?: string, to?: string) {
    requireOwner(user);

    return this.prisma.stockPurchase.findMany({
      where: {
        voidedAt: null,
        ...(branchId ? { branchId } : {}),
        ...(from || to ? { purchaseDate: dateRange(from, to) } : {}),
      },
      include: { branch: { select: { id: true, name: true } } },
      orderBy: { purchaseDate: 'desc' },
      take: 200,
    });
  }

  async voidPurchase(id: string, user: AuthUser) {
    requireOwner(user);

    const done = await this.prisma.stockPurchase.updateMany({
      where: { id, voidedAt: null },
      data: { voidedAt: new Date(), voidedById: user.id },
    });
    if (done.count === 0) throw new NotFoundException('Purchase not found or already voided.');
    return { id, voided: true };
  }

  // ---------- Shelf-stock value at the end of a month ----------

  // Saving the same branch + month again simply replaces the old value.
  async setValuation(
    input: { branchId?: string; month?: string; value?: unknown },
    user: AuthUser,
  ) {
    requireOwner(user);

    const value = parseAmount(input.value, true);
    const month = monthStart(input.month);

    const branchId = input.branchId?.trim();
    if (!branchId) throw new BadRequestException('Choose a branch.');
    await this.requireActiveBranch(branchId);

    return this.prisma.stockValuation.upsert({
      where: { branchId_month: { branchId, month } },
      create: { branchId, month, value, recordedById: user.id },
      update: { value, recordedById: user.id },
      include: { branch: { select: { id: true, name: true } } },
    });
  }

  async listValuations(user: AuthUser, branchId?: string) {
    requireOwner(user);

    return this.prisma.stockValuation.findMany({
      where: branchId ? { branchId } : {},
      include: { branch: { select: { id: true, name: true } } },
      orderBy: { month: 'desc' },
      take: 120,
    });
  }
}
