"use client";

import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";
import type { SupplierDto } from "@/modules/suppliers/application/suppliers";

type Props = { supplier?: SupplierDto };
type State = { kind: "idle" | "submitting" | "success" | "error"; message?: string };

export function SupplierForm({ supplier }: Props) {
  const router = useRouter(); const [state, setState] = useState<State>({ kind: "idle" });
  const idempotencyKey = useRef<string | null>(null);
  const editing = Boolean(supplier);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setState({ kind: "submitting" });
    const form = event.currentTarget; const data = new FormData(form); const csrf = await fetchCsrfToken();
    const common = {
      legalName: text(data, "legalName"), tradeName: optional(data, "tradeName"),
      fiscalAddressLine: text(data, "fiscalAddressLine"), fiscalPostalCode: text(data, "fiscalPostalCode"), fiscalCity: text(data, "fiscalCity"), fiscalProvince: optional(data, "fiscalProvince"), fiscalCountry: text(data, "fiscalCountry"), contactName: optional(data, "contactName"),
      defaultPaymentMethod: text(data, "defaultPaymentMethod"), paymentTermsType: text(data, "paymentTermsType"), paymentDays: numberOrNull(data, "paymentDays"), paymentFixedDay: numberOrNull(data, "paymentFixedDay"), notes: optional(data, "notes")
    };
    const sensitive = editing ? {
      expectedVersion: supplier!.version,
      taxId: change(data, "taxId", false), email: change(data, "email", data.has("clearEmail")), phone: change(data, "phone", data.has("clearPhone")),
      bank: data.has("clearBank") ? { mode: "clear" } : optional(data, "bankIban") ? { mode: "replace", iban: text(data, "bankIban"), bic: optional(data, "bankBic") } : { mode: "keep" }
    } : { taxId: text(data, "taxId"), email: optional(data, "email"), phone: optional(data, "phone"), bankIban: optional(data, "bankIban"), bankBic: optional(data, "bankBic") };
    const body = editing ? { action: "update", supplier: { ...common, ...sensitive } } : { ...common, ...sensitive };
    idempotencyKey.current ??= crypto.randomUUID();
    try {
      const response = await fetch(editing ? `/api/suppliers/${supplier!.id}` : "/api/suppliers", { method: editing ? "PATCH" : "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey.current, "X-CSRF-Token": csrf }, body: JSON.stringify(body) });
      if (response.ok) { idempotencyKey.current = null; if (!editing) form.reset(); setState({ kind: "success", message: editing ? "Proveedor actualizado." : "Proveedor creado." }); router.refresh(); return; }
      const error = await response.json().catch(() => null) as { message?: string } | null;
      if (response.status < 500) idempotencyKey.current = null;
      setState({ kind: "error", message: error?.message ?? (response.status >= 500 ? "Resultado incierto. Reintenta sin modificar los datos." : "No se pudo guardar el proveedor.") });
    } catch { setState({ kind: "error", message: "Resultado incierto. Reintenta sin modificar los datos para reutilizar la clave idempotente." }); }
  }
  return <form className="form-grid" onSubmit={submit}>
    <fieldset><legend>{editing ? `Editar ${supplier!.code}` : "Nuevo proveedor"}</legend>
      <div className="form-two-columns"><label>Razón social<input name="legalName" required minLength={2} maxLength={200} defaultValue={supplier?.legalName ?? ""}/></label><label>Nombre comercial<input name="tradeName" maxLength={160} defaultValue={supplier?.tradeName ?? ""}/></label></div>
      <div className="form-two-columns"><label>NIF / VAT {editing ? "nuevo (vacío conserva)" : ""}<input name="taxId" required={!editing} minLength={3} maxLength={32} autoComplete="off"/></label><label>Contacto<input name="contactName" maxLength={160} defaultValue={supplier?.contact.name ?? ""}/></label></div>
      <label>Dirección fiscal<input name="fiscalAddressLine" required minLength={3} maxLength={240} defaultValue={supplier?.fiscalAddress.line ?? ""}/></label>
      <div className="form-three-columns"><label>Código postal<input name="fiscalPostalCode" required maxLength={20} defaultValue={supplier?.fiscalAddress.postalCode ?? ""}/></label><label>Localidad<input name="fiscalCity" required maxLength={120} defaultValue={supplier?.fiscalAddress.city ?? ""}/></label><label>País<input name="fiscalCountry" required minLength={2} maxLength={2} defaultValue={supplier?.fiscalAddress.country ?? "ES"}/></label></div>
      <label>Provincia<input name="fiscalProvince" maxLength={120} defaultValue={supplier?.fiscalAddress.province ?? ""}/></label>
      <div className="form-two-columns"><label>Email {editing ? "nuevo (vacío conserva)" : ""}<input name="email" type="email" maxLength={254} autoComplete="off"/></label><label>Teléfono {editing ? "nuevo (vacío conserva)" : ""}<input name="phone" maxLength={40} autoComplete="off"/></label></div>
      {editing ? <div className="form-two-columns"><label><input name="clearEmail" type="checkbox"/> Eliminar email guardado</label><label><input name="clearPhone" type="checkbox"/> Eliminar teléfono guardado</label></div> : null}
      <div className="form-two-columns"><label>IBAN {editing ? "nuevo (vacío conserva)" : ""}<input name="bankIban" maxLength={40} autoComplete="off"/></label><label>BIC<input name="bankBic" maxLength={11} autoComplete="off"/></label></div>
      {editing ? <label><input name="clearBank" type="checkbox"/> Eliminar datos bancarios guardados</label> : null}
      <div className="form-three-columns"><label>Forma de pago<select name="defaultPaymentMethod" defaultValue={supplier?.paymentTerms.method ?? "BANK_TRANSFER"}><option value="BANK_TRANSFER">Transferencia</option><option value="CASH">Contado</option><option value="DIRECT_DEBIT">Domiciliación</option></select></label><label>Vencimiento<select name="paymentTermsType" defaultValue={supplier?.paymentTerms.type ?? "IMMEDIATE"}><option value="IMMEDIATE">Inmediato</option><option value="DAYS">A días</option><option value="FIXED_DAY_OF_MONTH">Día fijo</option></select></label><label>Días<input name="paymentDays" type="number" min={1} max={365} defaultValue={supplier?.paymentTerms.days ?? ""}/></label></div>
      <label>Día fijo del mes<input name="paymentFixedDay" type="number" min={1} max={31} defaultValue={supplier?.paymentTerms.fixedDay ?? ""}/></label>
      <label>Observaciones<textarea name="notes" maxLength={1000} rows={3} defaultValue={supplier?.notes ?? ""}/></label>
    </fieldset>
    <div className="form-actions"><button className="button" disabled={state.kind === "submitting"} type="submit">{state.kind === "submitting" ? "Guardando…" : editing ? "Guardar cambios" : "Crear proveedor"}</button>{state.message ? <p role="status" className={state.kind === "error" ? "message error" : "message"}>{state.message}</p> : null}</div>
  </form>;
}

function text(data: FormData, key: string) { return String(data.get(key) ?? "").trim(); }
function optional(data: FormData, key: string) { return text(data, key) || null; }
function numberOrNull(data: FormData, key: string) { const value = text(data, key); return value ? Number(value) : null; }
function change(data: FormData, key: string, clear: boolean): { mode: "keep" } | { mode: "clear" } | { mode: "replace"; value: string } { if (clear) return { mode: "clear" }; const value = text(data, key); return value ? { mode: "replace", value } : { mode: "keep" }; }
