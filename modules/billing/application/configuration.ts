import "server-only";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/modules/platform/application/auth";

const defaultBillingConfiguration = {
  invoiceLegalFooter: "",
  invoiceAccentColor: "#0f766e"
} as const;

export const updateBillingConfigurationSchema = z.object({
  invoiceLegalFooter: z.string().trim().max(3000).default(""),
  invoiceAccentColor: z
    .string()
    .trim()
    .regex(/^#[0-9A-Fa-f]{6}$/, "El color debe tener formato hexadecimal.")
    .transform((value) => value.toLocaleLowerCase("es-ES"))
}).strict();

export type UpdateBillingConfigurationCommand = z.infer<
  typeof updateBillingConfigurationSchema
>;

export type BillingConfiguration = {
  invoiceLegalFooter: string;
  invoiceAccentColor: string;
  updatedAt: string | null;
};

export type UpdateBillingConfigurationResult = {
  ok: true;
  status: 200;
  value: BillingConfiguration;
};

export async function getBillingConfiguration(): Promise<BillingConfiguration> {
  const configuration = await prisma.billingConfiguration.findUnique({
    where: { singletonKey: 1 },
    select: {
      invoiceLegalFooter: true,
      invoiceAccentColor: true,
      updatedAt: true
    }
  });

  if (!configuration) {
    return {
      ...defaultBillingConfiguration,
      updatedAt: null
    };
  }

  return mapBillingConfiguration(configuration);
}

export async function updateBillingConfiguration(
  command: UpdateBillingConfigurationCommand,
  actor: SessionUser
): Promise<UpdateBillingConfigurationResult> {
  const normalized = {
    invoiceLegalFooter: command.invoiceLegalFooter.trim(),
    invoiceAccentColor: command.invoiceAccentColor.toLocaleLowerCase("es-ES")
  };
  const configuration = await prisma.$transaction(async (tx) => {
    const previous = await tx.billingConfiguration.findUnique({
      where: { singletonKey: 1 },
      select: {
        invoiceLegalFooter: true,
        invoiceAccentColor: true
      }
    });
    const updated = await tx.billingConfiguration.upsert({
      where: { singletonKey: 1 },
      update: normalized,
      create: {
        singletonKey: 1,
        ...normalized
      },
      select: {
        invoiceLegalFooter: true,
        invoiceAccentColor: true,
        updatedAt: true
      }
    });

    await tx.auditEvent.create({
      data: {
        eventType: "BILLING_CONFIGURATION_UPDATED",
        actorType: "USER",
        payload: {
          actorUserId: actor.id,
          changedFields: changedBillingConfigurationFields(previous, normalized)
        }
      }
    });

    return updated;
  });

  return {
    ok: true,
    status: 200,
    value: mapBillingConfiguration(configuration)
  };
}

function changedBillingConfigurationFields(
  previous: {
    invoiceLegalFooter: string;
    invoiceAccentColor: string;
  } | null,
  next: {
    invoiceLegalFooter: string;
    invoiceAccentColor: string;
  }
): string[] {
  if (!previous) {
    return ["invoiceLegalFooter", "invoiceAccentColor"];
  }

  return [
    previous.invoiceLegalFooter !== next.invoiceLegalFooter
      ? "invoiceLegalFooter"
      : null,
    previous.invoiceAccentColor !== next.invoiceAccentColor
      ? "invoiceAccentColor"
      : null
  ].filter((field): field is string => field !== null);
}

function mapBillingConfiguration(configuration: {
  invoiceLegalFooter: string;
  invoiceAccentColor: string;
  updatedAt: Date;
}): BillingConfiguration {
  return {
    invoiceLegalFooter: configuration.invoiceLegalFooter,
    invoiceAccentColor: configuration.invoiceAccentColor,
    updatedAt: configuration.updatedAt.toISOString()
  };
}
