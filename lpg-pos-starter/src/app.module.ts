import {BrandsModule} from './brands/brands.module';
import {ProductsModule} from './products/products.module';
import { StockIntakeModule }  from './stock-intake/stock-intake.module';
import {InventoryModule} from './inventory/inventory.module';
import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { PrismaModule } from './prisma.module';
import { BranchesModule } from './branches/branches.module';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { SalesModule } from './sales/sales.module';
import { CustomersModule } from './customers/customers.module';
import {ReportsModule} from './reports/reports.module';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    BrandsModule,
    ProductsModule, 
    StockIntakeModule, 
    InventoryModule, 
    BranchesModule, 
    UsersModule,
    SalesModule,
    CustomersModule,
    ReportsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}