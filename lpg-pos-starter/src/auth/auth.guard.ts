import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { HealthController } from '../health.controller';
import { PrismaService } from '../prisma.service';

export type AuthUser = {
  id: string;
  name: string;
  email: string;
  role: 'SUPER_USER' | 'CASHIER';
  branchId: string | null;
};

const ROLES_KEY = 'roles';
const PUBLIC_KEY = 'isPublic';

// Marks a route as open to everyone (no sign-in needed).
// Every route needs sign-in unless it carries @Public().
export const Public = () => SetMetadata(PUBLIC_KEY, true);

// Decides which branch a request may use.
//  - Super Users may use any branch (or none, if the route allows it).
//  - Cashiers may only use their own branch, and asking for another
//    branch is refused.
export function scopeBranch(
  user: AuthUser,
  requested?: string,
): string | undefined {
  if (user.role === 'SUPER_USER') return requested?.trim() || undefined;

  if (!user.branchId) {
    throw new ForbiddenException('Your account is not assigned to a branch yet.');
  }

  const asked = requested?.trim();

  if (asked && asked !== user.branchId) {
    throw new ForbiddenException('You can only use your own branch.');
  }

  return user.branchId;
}

// Use on a route (or controller) to limit it to certain roles.
// Example: @Roles('SUPER_USER')
export const Roles = (...roles: Array<'SUPER_USER' | 'CASHIER'>) =>
  SetMetadata(ROLES_KEY, roles);

// Use in a route's parameters to get the signed-in user.
// Example: create(@CurrentUser() user: AuthUser)
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthUser =>
    context.switchToHttp().getRequest().user,
);

// The "bouncer". It runs on every route (see AuthModule). It checks the
// token, then re-checks the account in the database on every request, so a
// deactivated account is locked out immediately.
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      PUBLIC_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (isPublic || context.getClass() === HealthController) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const header: string | undefined = request.headers?.authorization;

    const token = header?.startsWith('Bearer ')
      ? header.slice(7).trim()
      : undefined;

    if (!token) {
      throw new UnauthorizedException('Please sign in.');
    }

    let userId: string | undefined;

    try {
      const payload = await this.jwt.verifyAsync<{ sub?: string }>(token);
      userId = payload?.sub;
    } catch {
      throw new UnauthorizedException(
        'Your session has expired. Please sign in again.',
      );
    }

    if (!userId) {
      throw new UnauthorizedException('Please sign in again.');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        status: true,
        isActive: true,
        branchId: true,
      },
    });

    if (!user || !user.isActive || user.status !== 'APPROVED') {
      throw new UnauthorizedException(
        'This account is no longer active. Please sign in again.',
      );
    }

    const authUser: AuthUser = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      branchId: user.branchId,
    };

    request.user = authUser;

    const allowed = this.reflector.getAllAndOverride<string[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (allowed?.length && !allowed.includes(user.role)) {
      throw new ForbiddenException(
        'You do not have permission to do that.',
      );
    }

    return true;
  }
}