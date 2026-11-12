# LPG Depot POS — Starter Backend

Starter scaffold: NestJS + TypeScript + Prisma + PostgreSQL.

## Prerequisites
- Node.js 20+
- npm
- PostgreSQL (local or hosted)

## Run locally
1. Copy `.env.example` to `.env` and set `DATABASE_URL`.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Generate Prisma client and create the initial database migration:
   ```bash
   npx prisma generate
   npx prisma migrate dev --name init
   ```
4. Start the API:
   ```bash
   npm run start:dev
   ```
5. Check `GET http://localhost:3000/health`.

## Included
- NestJS app and health endpoint
- Initial Prisma data model for branches, users, products, customers, inventory, stock movements, sales, payments, payment allocations, deliveries, and audit logs
- Environment example and basic scripts

## Deliberately not implemented yet
Authentication, role guards, sale/stock transaction logic, M-Pesa integration, offline mode, and delivery workflow. These should be added in small, testable steps rather than pretending the scaffold is a finished POS.

## MVP rules to preserve
- Customer records are company-wide; sales and repayments retain their branch.
- Inventory is tracked by branch + product + full/empty status.
- Keep stock movements as the audit trail.
- Do not calculate balances from a manually editable customer balance field.
- Implement sale + stock movements + payment writes in a database transaction.
