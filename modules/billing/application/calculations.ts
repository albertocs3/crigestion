import { Prisma } from "@prisma/client";

const moneyDecimals = 2;

export type InvoiceLineCalculationInput = {
  quantity: string | Prisma.Decimal;
  unitPrice: string | Prisma.Decimal;
  discountPercent?: string | Prisma.Decimal;
  discountAmount?: string | Prisma.Decimal;
  taxRate: string | Prisma.Decimal;
};

export type InvoiceLineCalculation = {
  lineSubtotal: Prisma.Decimal;
  lineDiscountTotal: Prisma.Decimal;
  lineTaxableBase: Prisma.Decimal;
  lineTaxAmount: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
};

export type InvoiceTaxSummaryCalculation = {
  taxRateCode: string;
  taxRate: Prisma.Decimal;
  taxableBase: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  total: Prisma.Decimal;
};

export type InvoiceTotalsCalculation = {
  subtotal: Prisma.Decimal;
  discountTotal: Prisma.Decimal;
  taxableBase: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  total: Prisma.Decimal;
};

export type InvoiceCalculatedLine = {
  taxRateCode: string;
  taxRate: Prisma.Decimal;
  lineSubtotal: Prisma.Decimal;
  lineDiscountTotal: Prisma.Decimal;
  lineTaxableBase: Prisma.Decimal;
  lineTaxAmount: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
};

export function calculateInvoiceLine(
  input: InvoiceLineCalculationInput
): InvoiceLineCalculation {
  const quantity = decimal(input.quantity);
  const unitPrice = decimal(input.unitPrice);
  const discountPercent = decimal(input.discountPercent ?? "0");
  const discountAmount = decimal(input.discountAmount ?? "0");
  const taxRate = decimal(input.taxRate);

  const lineSubtotal = roundMoney(quantity.mul(unitPrice));
  const percentDiscount = roundMoney(lineSubtotal.mul(discountPercent).div(100));
  const maxFixedDiscount = Prisma.Decimal.max(lineSubtotal.minus(percentDiscount), 0);
  const appliedFixedDiscount = Prisma.Decimal.min(discountAmount, maxFixedDiscount);
  const lineDiscountTotal = roundMoney(percentDiscount.plus(appliedFixedDiscount));
  const lineTaxableBase = roundMoney(
    Prisma.Decimal.max(lineSubtotal.minus(lineDiscountTotal), 0)
  );
  const lineTaxAmount = roundMoney(lineTaxableBase.mul(taxRate).div(100));
  const lineTotal = roundMoney(lineTaxableBase.plus(lineTaxAmount));

  return {
    lineSubtotal,
    lineDiscountTotal,
    lineTaxableBase,
    lineTaxAmount,
    lineTotal
  };
}

export function calculateInvoiceTotals(
  lines: InvoiceCalculatedLine[]
): InvoiceTotalsCalculation {
  return {
    subtotal: sumMoney(lines.map((line) => line.lineSubtotal)),
    discountTotal: sumMoney(lines.map((line) => line.lineDiscountTotal)),
    taxableBase: sumMoney(lines.map((line) => line.lineTaxableBase)),
    taxAmount: sumMoney(lines.map((line) => line.lineTaxAmount)),
    total: sumMoney(lines.map((line) => line.lineTotal))
  };
}

export function calculateInvoiceTaxSummaries(
  lines: InvoiceCalculatedLine[]
): InvoiceTaxSummaryCalculation[] {
  const grouped = new Map<string, InvoiceTaxSummaryCalculation>();

  for (const line of lines) {
    const key = `${line.taxRateCode}:${line.taxRate.toFixed(2)}`;
    const existing = grouped.get(key);

    if (!existing) {
      grouped.set(key, {
        taxRateCode: line.taxRateCode,
        taxRate: line.taxRate,
        taxableBase: line.lineTaxableBase,
        taxAmount: line.lineTaxAmount,
        total: line.lineTotal
      });
      continue;
    }

    grouped.set(key, {
      ...existing,
      taxableBase: roundMoney(existing.taxableBase.plus(line.lineTaxableBase)),
      taxAmount: roundMoney(existing.taxAmount.plus(line.lineTaxAmount)),
      total: roundMoney(existing.total.plus(line.lineTotal))
    });
  }

  return [...grouped.values()].sort((a, b) =>
    a.taxRateCode.localeCompare(b.taxRateCode, "es-ES")
  );
}

export function roundMoney(value: Prisma.Decimal): Prisma.Decimal {
  return new Prisma.Decimal(value.toFixed(moneyDecimals));
}

export function decimal(value: string | Prisma.Decimal): Prisma.Decimal {
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
}

function sumMoney(values: Prisma.Decimal[]): Prisma.Decimal {
  return roundMoney(
    values.reduce(
      (total, value) => total.plus(value),
      new Prisma.Decimal(0)
    )
  );
}
