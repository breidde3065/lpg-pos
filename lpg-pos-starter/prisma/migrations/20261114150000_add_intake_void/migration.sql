ALTER TABLE "stock_intakes" ADD COLUMN "voided_at" TIMESTAMP(3),
ADD COLUMN "voided_by_id" UUID;