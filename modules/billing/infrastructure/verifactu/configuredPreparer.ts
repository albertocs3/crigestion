import "server-only";

import type { VerifactuAltaPreparer } from "@/modules/billing/application/invoices";
import { createAeatF1AltaPreparer } from "@/modules/billing/infrastructure/verifactu/aeatF1Preparer";
import { createAeatAnulacionPreparer, type VerifactuAnulacionPreparer } from "@/modules/billing/infrastructure/verifactu/aeatAnulacionPreparer";
import { readVerifactuPayloadCipherFromEnvironment } from "@/modules/billing/infrastructure/verifactu/payloadCipher";
import { isVerifactuPreparationAllowed } from "@/modules/platform/application/operationalEnvironment";

export function readConfiguredVerifactuAltaPreparer(
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
  onConfigurationError: (code: string) => void = (code) => console.error(code)
): VerifactuAltaPreparer | undefined {
  if (!isVerifactuPreparationAllowed(env)) return undefined;
  try {
    const cipher = readVerifactuPayloadCipherFromEnvironment(env);
    return createAeatF1AltaPreparer({
      cipher,
      nowWithOffset: () => formatEuropeMadridDateTime(now())
    });
  } catch {
    onConfigurationError("VERIFACTU_PREPARER_CONFIGURATION_INVALID");
    return undefined;
  }
}

export function readConfiguredVerifactuAnulacionPreparer(
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
  onConfigurationError: (code: string) => void = (code) => console.error(code)
): VerifactuAnulacionPreparer | undefined {
  if (!isVerifactuPreparationAllowed(env)) return undefined;
  try {
    const cipher = readVerifactuPayloadCipherFromEnvironment(env);
    return createAeatAnulacionPreparer({ cipher, nowWithOffset: () => formatEuropeMadridDateTime(now()) });
  } catch {
    onConfigurationError("VERIFACTU_PREPARER_CONFIGURATION_INVALID");
    return undefined;
  }
}

export function formatEuropeMadridDateTime(value: Date): string {
  if (Number.isNaN(value.getTime())) throw new Error("VERIFACTU_CLOCK_INVALID");
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const parts = Object.fromEntries(formatter.formatToParts(value).map((part) => [part.type, part.value]));
  const localUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  const offsetMinutes = Math.round((localUtc - Math.trunc(value.getTime() / 1000) * 1000) / 60_000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const offset = `${sign}${Math.floor(absolute / 60).toString().padStart(2, "0")}:${(absolute % 60).toString().padStart(2, "0")}`;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}
