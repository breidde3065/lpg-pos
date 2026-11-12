import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { AuthUser, CurrentUser, Roles } from '../auth/auth.guard';

// Everything here is for Super Users only.
@Controller('users')
@Roles('SUPER_USER')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  findAll() {
    return this.usersService.findAll();
  }

  // Registrations waiting for a decision.
  @Get('pending')
  findPending() {
    return this.usersService.findPending();
  }

  // Create an account directly (already approved).
  @Post()
  create(
    @Body()
    body: {
      name?: string;
      email?: string;
      password?: string;
      branchId?: string;
      role?: string;
    },
  ) {
    return this.usersService.create(body);
  }

  @Post(':id/approve')
  approve(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.usersService.approve(id);
  }

  @Post(':id/reject')
  reject(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.usersService.reject(id);
  }

  @Post(':id/deactivate')
  deactivate(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.usersService.deactivate(id, actor.id);
  }

  @Post(':id/reactivate')
  reactivate(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.usersService.reactivate(id);
  }

  @Patch(':id/branch')
  changeBranch(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: { branchId?: string },
  ) {
    return this.usersService.changeBranch(id, body.branchId);
  }
}