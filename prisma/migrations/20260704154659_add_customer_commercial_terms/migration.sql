-- CreateEnum
CREATE TYPE "CustomerPaymentMethod" AS ENUM ('BANK_TRANSFER', 'CASH', 'DIRECT_DEBIT');

-- CreateEnum
CREATE TYPE "CustomerPaymentTermsType" AS ENUM ('IMMEDIATE', 'DAYS', 'FIXED_DAY_OF_MONTH');

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "creditLimit" DECIMAL(12,2),
ADD COLUMN     "defaultPaymentMethod" "CustomerPaymentMethod" NOT NULL DEFAULT 'BANK_TRANSFER',
ADD COLUMN     "paymentDays" INTEGER,
ADD COLUMN     "paymentFixedDay" INTEGER,
ADD COLUMN     "paymentTermsType" "CustomerPaymentTermsType" NOT NULL DEFAULT 'IMMEDIATE';
