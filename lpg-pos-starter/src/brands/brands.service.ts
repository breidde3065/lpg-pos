import {
  BadRequestException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class BrandsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(search?: string) {
    const term = search?.trim();

    return this.prisma.brand.findMany({
      where: term
        ? {
            name: {
              contains: term,
              mode: 'insensitive',
            },
          }
        : undefined,
      orderBy: { name: 'asc' },
      include: {
        _count: {
          select: { products: true },
        },
      },
    });
  }

  async create(rawName: string) {
    const name = rawName.trim().replace(/\s+/g, ' ');

    if (!name) {
      throw new BadRequestException('Brand name is required.');
    }

    // If a brand with the same name already exists (ignoring upper/lower
    // case), reuse it instead of creating a duplicate or raising an error.
    const existing = await this.findByName(name);

    if (existing) {
      return existing;
    }

    try {
      return await this.prisma.brand.create({
        data: { name },
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P2002'
      ) {
        // Two people registered the same brand at the same moment.
        // The other request won, so return the brand it created.
        const winner = await this.findByName(name);

        if (winner) {
          return winner;
        }
      }

      throw error;
    }
  }

  private findByName(name: string) {
    return this.prisma.brand.findFirst({
      where: {
        name: { equals: name, mode: 'insensitive' },
      },
    });
  }
}