import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(search?: string) {
    const term = search?.trim();

    return this.prisma.customer.findMany({
      where: {
        isActive: true,
        ...(term
          ? {
              OR: [
                { name: { contains: term, mode: 'insensitive' as const } },
                { phone: { contains: term.replace(/\s+/g, '') } },
              ],
            }
          : {}),
      },
      orderBy: { name: 'asc' },
      take: 20,
    });
  }

  async create(input: { name?: string; phone?: string }) {
    const name = input.name?.trim().replace(/\s+/g, ' ');

    if (!name || name.length < 2) {
      throw new BadRequestException('Customer name is required.');
    }

    if (name.length > 80) {
      throw new BadRequestException('Customer name is too long.');
    }

    let phone: string | null = null;
    const raw = input.phone?.trim();

    if (raw) {
      const digits = raw.replace(/\D/g, '');

      if (digits.length < 9 || digits.length > 15) {
        throw new BadRequestException('Enter a valid phone number.');
      }

      phone = (raw.startsWith('+') ? '+' : '') + digits;

      // The same phone number is the same customer: reuse them instead of
      // creating a duplicate (matches 0712... and 254712... alike).
      const existing = await this.prisma.customer.findFirst({
        where: { isActive: true, phone: { contains: digits.slice(-9) } },
      });

      if (existing) return existing;
    }

    return this.prisma.customer.create({ data: { name, phone } });
  }
}