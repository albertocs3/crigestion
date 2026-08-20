import "server-only";

import { z } from "zod";

export const supportDateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha debe tener formato YYYY-MM-DD.")
  .refine((value) => formatDateOnly(parseDateOnly(value)) === value, "La fecha no es válida.");

export function validateMadridDateRange(
  from: string | undefined,
  to: string | undefined,
  context: z.RefinementCtx,
  fromPath: string,
  toPath: string,
): void {
  if (Boolean(from) !== Boolean(to)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [from ? toPath : fromPath],
      message: "Debes indicar las dos fechas del rango.",
    });
    return;
  }
  if (!from || !to) return;
  const start = parseDateOnly(from);
  const end = parseDateOnly(to);
  if (start > end) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: [toPath], message: "La fecha final no puede ser anterior a la inicial." });
    return;
  }
  const inclusiveDays = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (inclusiveDays > 366) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: [toPath], message: "El rango no puede superar 366 días." });
  }
}

export function madridDateRange(from: string, to: string): { gte: Date; lt: Date } {
  return { gte: madridStartOfDay(from), lt: nextMadridDateOnly(to) };
}

function parseDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function formatDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function madridStartOfDay(value: string): Date {
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const utcMidnight = new Date(Date.UTC(year, month - 1, day));
  const firstOffset = madridOffsetMinutes(utcMidnight);
  let result = new Date(utcMidnight.getTime() - firstOffset * 60_000);
  const exactOffset = madridOffsetMinutes(result);
  if (exactOffset !== firstOffset) result = new Date(utcMidnight.getTime() - exactOffset * 60_000);
  return result;
}

function madridOffsetMinutes(value: Date): number {
  const zone = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid",
    timeZoneName: "longOffset",
  }).formatToParts(value).find((part) => part.type === "timeZoneName")?.value;
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(zone ?? "");
  if (!match) throw new Error("SUPPORT_TIME_ZONE_UNAVAILABLE");
  return (Number(match[2]) * 60 + Number(match[3])) * (match[1] === "+" ? 1 : -1);
}

function nextMadridDateOnly(value: string): Date {
  const next = parseDateOnly(value);
  next.setUTCDate(next.getUTCDate() + 1);
  return madridStartOfDay(formatDateOnly(next));
}
