import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { UserRole, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma.service';

// What the owner's screens are allowed to see about a user (never the
// password hash).
const ADMIN_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  status: true,
  branchId: true,
  isActive: true,
  createdAt: true,
  branch: { select: { id: true, name: true } },
} as const;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        status: true,
        branchId: true,
        isActive: true,
        createdAt: true,
        branch: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  findPending() {
    return this.prisma.user.findMany({
      where: { status: UserStatus.PENDING },
      select: ADMIN_SELECT,
      orderBy: { createdAt: 'asc' },
    });
  }

  async create(input: {
    name?: string;
    email?: string;
    password?: string;
    branchId?: string;
    role?: string;
  }) {
    const name = input.name?.trim();
    const email = input.email?.trim().toLowerCase();
    const password = input.password;
    const role = (input.role ?? 'CASHIER').toUpperCase();

    if (!name || !email || !password) {
      throw new BadRequestException(
        'Name, email, and password are required.',
      );
    }

    if (password.length < 8) {
      throw new BadRequestException(
        'Password must contain at least 8 characters.',
      );
    }

    if (!Object.values(UserRole).includes(role as UserRole)) {
      throw new BadRequestException(
        'Role must be SUPER_USER or CASHIER.',
      );
    }

    const branchId = input.branchId?.trim() || null;

    if (role === 'CASHIER' && !branchId) {
      throw new BadRequestException(
        'A cashier must be assigned to a branch.',
      );
    }

    if (branchId) {
      const branch = await this.prisma.branch.findUnique({
        where: { id: branchId },
      });

      if (!branch || !branch.isActive) {
        throw new NotFoundException(
          'Assigned branch was not found or is inactive.',
        );
      }
    }

    const passwordHash = await bcrypt.hash(password, 12);

    try {
      const user = await this.prisma.user.create({
        data: {
          name,
          email,
          passwordHash,
          role: role as UserRole,
          status: 'APPROVED',
          branchId,
        },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          status: true,
          branchId: true,
          isActive: true,
          createdAt: true,
        },
      });

      return user;
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'That email address is already registered.',
        );
      }

      throw error;
    }
  }

  async approve(id: string) {
    const user = await this.getOrThrow(id);

    if (
      user.status !== UserStatus.PENDING &&
      user.status !== UserStatus.REJECTED
    ) {
      throw new BadRequestException(
        'Only pending or rejected registrations can be approved.',
      );
    }

    if (user.role === UserRole.CASHIER && !user.branchId) {
      throw new BadRequestException(
        'This cashier has no branch. Assign a branch first.',
      );
    }

    return this.prisma.user.update({
      where: { id },
      data: { status: UserStatus.APPROVED, isActive: true },
      select: ADMIN_SELECT,
    });
  }

  async reject(id: string) {
    const user = await this.getOrThrow(id);

    if (user.status !== UserStatus.PENDING) {
      throw new BadRequestException(
        'Only pending registrations can be rejected.',
      );
    }

    return this.prisma.user.update({
      where: { id },
      data: { status: UserStatus.REJECTED },
      select: ADMIN_SELECT,
    });
  }

  async deactivate(id: string, actorId: string) {
    if (id === actorId) {
      throw new BadRequestException(
        'You cannot deactivate your own account.',
      );
    }

    const user = await this.getOrThrow(id);

    if (user.status !== UserStatus.APPROVED) {
      throw new BadRequestException(
        'Only approved accounts can be deactivated.',
      );
    }

    // There must always be at least one active Super User.
    if (user.role === UserRole.SUPER_USER) {
      const others = await this.prisma.user.count({
        where: {
          role: UserRole.SUPER_USER,
          status: UserStatus.APPROVED,
          isActive: true,
          id: { not: id },
        },
      });

      if (others === 0) {
        throw new BadRequestException(
          'There must always be at least one active Super User.',
        );
      }
    }

    return this.prisma.user.update({
      where: { id },
      data: { status: UserStatus.DEACTIVATED, isActive: false },
      select: ADMIN_SELECT,
    });
  }

  async reactivate(id: string) {
    const user = await this.getOrThrow(id);

    if (user.status !== UserStatus.DEACTIVATED) {
      throw new BadRequestException(
        'Only deactivated accounts can be reactivated.',
      );
    }

    return this.prisma.user.update({
      where: { id },
      data: { status: UserStatus.APPROVED, isActive: true },
      select: ADMIN_SELECT,
    });
  }

  async changeBranch(id: string, rawBranchId?: string) {
    const branchId = rawBranchId?.trim();

    if (!branchId) {
      throw new BadRequestException('A branch is required.');
    }

    const user = await this.getOrThrow(id);

    if (user.role !== UserRole.CASHIER) {
      throw new BadRequestException(
        'Only cashiers are assigned to a branch.',
      );
    }

    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
    });

    if (!branch || !branch.isActive) {
      throw new NotFoundException('That branch was not found or is inactive.');
    }

    return this.prisma.user.update({
      where: { id },
      data: { branchId },
      select: ADMIN_SELECT,
    });
  }

  private async getOrThrow(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });

    if (!user) {
      throw new NotFoundException('User not found.');
    }

    return user;
  }
}