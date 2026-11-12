import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { JWT_SECRET, TOKEN_LIFETIME_SECONDS } from './auth.constants';

@Global()
@Module({
  imports: [
    JwtModule.register({
      secret: JWT_SECRET,
      signOptions: { expiresIn: TOKEN_LIFETIME_SECONDS },
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    // Makes AuthGuard run on EVERY route. Open routes must say @Public().
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [JwtModule],
})
export class AuthModule {}