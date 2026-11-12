import { Body, Controller, Get, Post } from '@nestjs/common';
import { BranchesService } from './branches.service';
import { Roles } from '../auth/auth.guard';

@Controller('branches')
export class BranchesController {
  constructor(private readonly branchesService: BranchesService) {}

  @Get()
  findAll() {
    return this.branchesService.findAll();
  }

  // Only a Super User can add a branch.
  @Post()
  @Roles('SUPER_USER')
  create(@Body() body: { name?: string; code?: string; address?: string }) {
    return this.branchesService.create(body);
  }
}