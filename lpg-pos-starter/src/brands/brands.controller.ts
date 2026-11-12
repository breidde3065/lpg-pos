import {
  Body,
  Controller,
  Get,
  Post,
  Query,
} from '@nestjs/common';
import { BrandsService } from './brands.service';

@Controller('brands')
export class BrandsController {
  constructor(private readonly brandsService: BrandsService) {}

  @Get()
  findAll(@Query('search') search?: string) {
    return this.brandsService.findAll(search);
  }

  @Post()
  create(@Body() body: { name?: string }) {
    return this.brandsService.create(body.name ?? '');
  }
}