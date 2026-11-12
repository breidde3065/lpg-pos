import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthUser, CurrentUser, Public } from './auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // Open to everyone: the registration form needs the branch list.
  @Public()
  @Get('branches')
  branches() {
    return this.authService.branches();
  }

  // Open to everyone: a cashier asks for an account (waits for approval).
  @Public()
  @Post('register')
  register(
    @Body()
    body: {
      name?: string;
      email?: string;
      password?: string;
      branchId?: string;
    },
  ) {
    return this.authService.register(body);
  }

  // Open to everyone: sign in and receive a token.
  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() body: { email?: string; password?: string }) {
    return this.authService.login(body);
  }

  // Needs sign-in: who am I?
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.authService.me(user.id);
  }
}