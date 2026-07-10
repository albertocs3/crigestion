import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { isValidIban, normalizeIban } from "@/modules/customers/application/customers";
import type { SessionUser } from "@/modules/platform/application/auth";

const bankIbanSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .transform(normalizeIban)
  .refine(isValidIban, "El IBAN no es valido.");

const sepaCreditorIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(35)
  .transform((value) => value.toUpperCase())
  .refine(
    (value) => /^[A-Z]{2}[0-9A-Z]{3,33}$/.test(value),
    "El identificador acreedor SEPA no tiene un formato valido."
  );

export const updateCompanyConfigurationSchema = z.object({
  legalName: z.string().trim().min(2).max(200),
  taxId: z.string().trim().min(3).max(32),
  email: z.string().trim().email().max(254).optional(),
  bankIban: bankIbanSchema.optional(),
  sepaCreditorIdentifier: sepaCreditorIdentifierSchema.optional()
});

export type UpdateCompanyConfigurationCommand = z.infer<
  typeof updateCompanyConfigurationSchema
>;

export type PlatformConfiguration = {
  company: {
    id: string;
    legalName: string;
    taxId: string;
    email: string | null;
    bankIban: string | null;
    sepaCreditorIdentifier: string | null;
    updatedAt: string;
  };
  installation: {
    id: string;
    status: string;
    productVersion: string;
    completedAt: string | null;
  };
};

export type UpdateCompanyConfigurationResult =
  | { ok: true; status: 200; value: PlatformConfiguration["company"] }
  | {
      ok: false;
      status: 404 | 409;
      error: {
        code:
          | "CONFIGURATION_NOT_FOUND"
          | "COMPANY_TAX_ID_ALREADY_USED"
          | "COMPANY_TAX_ID_LOCKED_BY_ISSUED_INVOICES";
        message: string;
      };
    };

export async function getPlatformConfiguration(): Promise<PlatformConfiguration | null> {
  const installation = await prisma.installation.findFirst({
    where: {
      status: "INITIALIZED"
    },
    select: {
      id: true,
      status: true,
      productVersion: true,
      completedAt: true,
      company: {
        select: {
          id: true,
          legalName: true,
          taxId: true,
          email: true,
          bankIban: true,
          sepaCreditorIdentifier: true,
          updatedAt: true
        }
      }
    }
  });

  if (!installation?.company) {
    return null;
  }

  return {
    company: mapCompany(installation.company),
    installation: {
      id: installation.id,
      status: installation.status,
      productVersion: installation.productVersion,
      completedAt: installation.completedAt?.toISOString() ?? null
    }
  };
}

export async function updateCompanyConfiguration(
  command: UpdateCompanyConfigurationCommand,
  actor: SessionUser
): Promise<UpdateCompanyConfigurationResult> {
  const installation = await prisma.installation.findFirst({
    where: {
      status: "INITIALIZED"
    },
    select: {
      company: {
        select: {
          id: true,
          legalName: true,
          taxId: true,
          email: true,
          bankIban: true,
          sepaCreditorIdentifier: true
        }
      }
    }
  });

  if (!installation?.company) {
    return configurationNotFound();
  }

  const previousCompany = installation.company;
  const normalizedCommand = normalizeCompanyConfigurationCommand(command);
  const changedFields = changedCompanyFields(previousCompany, normalizedCommand);
  const taxIdChanged = previousCompany.taxId !== command.taxId;

  const taxIdLocked = taxIdChanged && (await hasIssuedInvoices());

  if (taxIdLocked) {
    return {
      ok: false,
      status: 409,
      error: {
        code: "COMPANY_TAX_ID_LOCKED_BY_ISSUED_INVOICES",
        message: "El NIF de la empresa no puede cambiarse cuando existen facturas emitidas."
      }
    };
  }

  try {
    const company = await prisma.$transaction(async (tx) => {
      const updatedCompany = await tx.company.update({
        where: { id: previousCompany.id },
        data: {
          legalName: command.legalName,
          taxId: command.taxId,
          email: normalizedCommand.email ?? null,
          bankIban: normalizedCommand.bankIban ?? null,
          sepaCreditorIdentifier: normalizedCommand.sepaCreditorIdentifier ?? null
        },
        select: {
          id: true,
          legalName: true,
          taxId: true,
          email: true,
          bankIban: true,
          sepaCreditorIdentifier: true,
          updatedAt: true
        }
      });

      await tx.auditEvent.create({
        data: {
          eventType: "COMPANY_CONFIGURATION_UPDATED",
          actorType: "USER",
          payload: {
            actorUserId: actor.id,
            companyId: updatedCompany.id,
            changedFields
          }
        }
      });

      return updatedCompany;
    });

    return {
      ok: true,
      status: 200,
      value: mapCompany(company)
    };
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return {
        ok: false,
        status: 409,
        error: {
          code: "COMPANY_TAX_ID_ALREADY_USED",
          message: "El NIF indicado ya esta asignado a otra empresa."
        }
      };
    }

    throw error;
  }
}

async function hasIssuedInvoices(): Promise<boolean> {
  const issuedInvoiceCount = await prisma.invoice.count({
    where: {
      status: {
        not: "DRAFT"
      }
    }
  });

  return issuedInvoiceCount > 0;
}

function normalizeCompanyConfigurationCommand(
  command: UpdateCompanyConfigurationCommand
): UpdateCompanyConfigurationCommand {
  return {
    ...command,
    email: command.email ?? undefined,
    bankIban: command.bankIban ? normalizeIban(command.bankIban) : undefined,
    sepaCreditorIdentifier: command.sepaCreditorIdentifier
      ? command.sepaCreditorIdentifier.toUpperCase()
      : undefined
  };
}

function changedCompanyFields(
  previousCompany: {
    legalName: string;
    taxId: string;
    email: string | null;
    bankIban: string | null;
    sepaCreditorIdentifier: string | null;
  },
  command: UpdateCompanyConfigurationCommand
): string[] {
  return [
    previousCompany.legalName !== command.legalName ? "legalName" : null,
    previousCompany.taxId !== command.taxId ? "taxId" : null,
    previousCompany.email !== (command.email ?? null) ? "email" : null,
    previousCompany.bankIban !== (command.bankIban ?? null) ? "bankIban" : null,
    previousCompany.sepaCreditorIdentifier !== (command.sepaCreditorIdentifier ?? null)
      ? "sepaCreditorIdentifier"
      : null
  ].filter((field): field is string => field !== null);
}

function mapCompany(company: {
  id: string;
  legalName: string;
  taxId: string;
  email: string | null;
  bankIban: string | null;
  sepaCreditorIdentifier: string | null;
  updatedAt: Date;
}): PlatformConfiguration["company"] {
  return {
    id: company.id,
    legalName: company.legalName,
    taxId: company.taxId,
    email: company.email,
    bankIban: company.bankIban,
    sepaCreditorIdentifier: company.sepaCreditorIdentifier,
    updatedAt: company.updatedAt.toISOString()
  };
}

function configurationNotFound(): UpdateCompanyConfigurationResult {
  return {
    ok: false,
    status: 404,
    error: {
      code: "CONFIGURATION_NOT_FOUND",
      message: "La configuracion de plataforma no existe."
    }
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}
