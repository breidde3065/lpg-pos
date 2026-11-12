import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma.service';

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_WINDOW_MS = 10 * 60 * 1000;

// Used so a wrong email takes as long to reject as a wrong password.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

@Injectable()
export class AuthService {
  // Remembers failed sign-ins per email. Lives in memory, so it resets
  // when the server restarts.
  private readonly failures = new Map<
    string,
    { count: number; since: number }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  // Branch names for the registration form (works before signing in).
  branches() {
    return this.prisma.branch.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  async register(input: {
    name?: string;
    email?: string;
    password?: string;
    branchId?: string;
  }) {
    const name = input.name?.trim().replace(/\s+/g, ' ');
    const email = input.email?.trim().toLowerCase();
    const password = input.password;
    const branchId = input.branchId?.trim();

    if (!name || !email || typeof password !== 'string' || !branchId) {
      throw new BadRequestException(
        'Name, email, password and branch are required.',
      );
    }

    if (!EMAIL_PATTERN.test(email)) {
      throw new BadRequestException('Enter a valid email address.');
    }

    if (password.length < 8) {
      throw new BadRequestException(
        'Password must contain at least 8 characters.',
      );
    }

    if (password.length > 72) {
      throw new BadRequestException(
        'Password must be 72 characters or fewer.',
      );
    }

    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
    });

    if (!branch || !branch.isActive) {
      throw new NotFoundException('That branch was not found.');
    }

    const passwordHash = await bcrypt.hash(password, 12);

    try {
      // Role and status are fixed here on purpose: nobody can register
      // themselves as a Super User or as already approved.
      await this.prisma.user.create({
        data: {
          name,
          email,
          passwordHash,
          role: 'CASHIER',
          status: 'PENDING',
          branchId,
        },
      });
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

    return {
      message:
        'Registration received. A Super User must approve your account before you can sign in.',
    };
  }

  async login(input: { email?: string; password?: string }) {
    const email = input.email?.trim().toLowerCase();
    const password = input.password;

    if (!email || typeof password !== 'string' || !password) {
      throw new BadRequestException('Email and password are required.');
    }

    this.assertNotLocked(email);

    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { branch: { select: { id: true, name: true } } },
    });

    const passwordOk = await bcrypt.compare(
      password,
      user?.passwordHash ?? DUMMY_HASH,
    );

    if (!user || !passwordOk) {
      this.recordFailure(email);
      throw new UnauthorizedException('Incorrect email or password.');
    }

    // The password is right. Now check the account is allowed in.
    if (user.status === 'PENDING') {
      throw new ForbiddenException(
        'Your account is waiting for approval by a Super User.',
      );
    }

    if (user.status === 'REJECTED') {
      throw new ForbiddenException(
        'Your registration was not approved. Please contact the owner.',
      );
    }

    if (user.status !== 'APPROVED' || !user.isActive) {
      throw new ForbiddenException(
        'This account has been deactivated. Please contact the owner.',
      );
    }

    this.failures.delete(email);

    const token = await this.jwt.signAsync({ sub: user.id });

    return {
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        branchId: user.branchId,
        branch: user.branch,
      },
    };
  }

  // The signed-in person's current details (the app asks for this on
  // start-up, so a changed branch or role shows up straight away).
  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        branchId: true,
        branch: { select: { id: true, name: true } },
      },
    });

    if (!user) {
      throw new UnauthorizedException('Please sign in again.');
    }

    return user;
  }

  private assertNotLocked(email: string) {
    const record = this.failures.get(email);

    if (!record) return;

    if (Date.now() - record.since > LOCK_WINDOW_MS) {
      this.failures.delete(email);
      return;
    }

    if (record.count >= MAX_FAILED_ATTEMPTS) {
      throw new HttpException(
        'Too many failed sign-in attempts. Please wait 10 minutes and try again.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private recordFailure(email: string) {
    const now = Date.now();

    // Keep the memory tidy by clearing old entries.
    if (this.failures.size > 5000) {
      for (const [key, value] of this.failures) {
        if (now - value.since > LOCK_WINDOW_MS) this.failures.delete(key);
      }
    }

    const record = this.failures.get(email);

    if (!record || now - record.since > LOCK_WINDOW_MS) {
      this.failures.set(email, { count: 1, since: now });
    } else {
      record.count += 1;
    }
  }
}