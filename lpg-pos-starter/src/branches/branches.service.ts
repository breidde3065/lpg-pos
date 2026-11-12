import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class BranchesService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.branch.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  async create(input: {
    name?: string;
    code?: string;
    address?: string;
  }) {
    const name = input.name?.trim();
    const code = input.code?.trim().toUpperCase();

    if (!name || !code) {
      throw new BadRequestException('Branch name and code are required.');
    }

    try {
      return await this.prisma.branch.create({
        data: {
          name,
          code,
          address: input.address?.trim() || null,
        },
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('That branch code is already in use.');
      }

      throw error;
    }
  }
}