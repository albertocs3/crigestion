"use client";

import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";
import type { SubscriptionDto, SubscriptionReferences } from "@/modules/subscriptions/application/subscriptions";

type Props = { subscription: SubscriptionDto; references: SubscriptionReferences; canManageEconomics: boolean };
type LineState = { catalogItemId: string; quantity: string; unitPrice: string; discountPercent: string; discountAmount: string };

export function SubscriptionEditForm({ subscription, references, canManageEconomics }: Props) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [lines, setLines] = useState<LineState[]>(subscription.lines.map((line) => ({
    catalogItemId: line.catalogItemId,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    discountPercent: line.discountPercent,
    discountAmount: line.discountAmount
  })));
  const retry = useRef<{ payload: string; key: string } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSubmitting(true); setMessage(null);
    const data = new FormData(event.currentTarget);
    const body = {
      expectedVersion: subscription.version,
      customerId: String(data.get("customerId") ?? ""),
      name: String(data.get("name") ?? ""),
      periodicity: String(data.get("periodicity") ?? "MONTHLY"),
      pricingMode: String(data.get("pricingMode") ?? "FIXED"),
      startDate: String(data.get("startDate") ?? ""),
      endDate: nullable(data.get("endDate")),
      notes: nullable(data.get("notes")),
      lines: lines.map((line) => canManageEconomics ? line : { catalogItemId: line.catalogItemId, quantity: line.quantity })
    };
    const payload = JSON.stringify(body);
    if (!retry.current || retry.current.payload !== payload) retry.current = { payload, key: crypto.randomUUID() };
    try {
      const csrfToken = await fetchCsrfToken();
      const response = await fetch(`/api/subscriptions/${subscription.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "Idempotency-Key": retry.current.key, "X-CSRF-Token": csrfToken },
        body: payload
      });
      const result = (await response.json().catch(() => null)) as { message?: string; code?: string } | null;
      if (!response.ok) setMessage(result?.message ?? result?.code ?? "No se pudo actualizar la suscripcion.");
      else { retry.current = null; setMessage("Borrador actualizado."); router.refresh(); }
    } catch { setMessage("No se pudo conectar con el servidor."); }
    finally { setSubmitting(false); }
  }

  function updateLine(index: number, field: keyof LineState, value: string) {
    setLines((current) => current.map((line, lineIndex) => lineIndex === index ? { ...line, [field]: value } : line));
  }

  return <form className="form-grid" onSubmit={submit} aria-busy={submitting}>
    <fieldset disabled={submitting}><legend>Editar borrador</legend><div className="form-two-columns">
      <label>Cliente<select name="customerId" required defaultValue={subscription.customer.id}>{references.customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.code} - {customer.legalName}</option>)}</select></label>
      <label>Nombre<input name="name" required minLength={2} maxLength={200} defaultValue={subscription.name} /></label>
      <label>Periodicidad<select name="periodicity" defaultValue={subscription.periodicity}><option value="MONTHLY">Mensual</option><option value="QUARTERLY">Trimestral</option><option value="SEMIANNUAL">Semestral</option><option value="ANNUAL">Anual</option></select></label>
      <label>Modalidad<select name="pricingMode" defaultValue={subscription.pricingMode}><option value="FIXED">Importe fijo</option><option value="PER_LICENSE">Por licencias</option></select></label>
      <label>Fecha de inicio<input name="startDate" type="date" required defaultValue={subscription.startDate} /></label>
      <label>Fecha final<input name="endDate" type="date" defaultValue={subscription.endDate ?? ""} /></label>
    </div><label>Observaciones<textarea name="notes" maxLength={1000} defaultValue={subscription.notes ?? ""} /></label>
    <div className="stack"><h3>Conceptos</h3>{lines.map((line, index) => <div className="form-three-columns" key={`${line.catalogItemId}-${index}`}>
      <label>Concepto<select value={line.catalogItemId} disabled={!canManageEconomics} onChange={(event) => updateLine(index, "catalogItemId", event.currentTarget.value)}>{references.catalogItems.map((item) => <option key={item.id} value={item.id}>{item.code} - {item.name}</option>)}</select></label>
      <label>Cantidad<input value={line.quantity} disabled={!canManageEconomics} required inputMode="decimal" onChange={(event) => updateLine(index, "quantity", event.currentTarget.value)} /></label>
      {canManageEconomics ? <><label>Precio<input value={line.unitPrice} required inputMode="decimal" onChange={(event) => updateLine(index, "unitPrice", event.currentTarget.value)} /></label><label>Descuento %<input value={line.discountPercent} required inputMode="decimal" onChange={(event) => updateLine(index, "discountPercent", event.currentTarget.value)} /></label><label>Descuento fijo<input value={line.discountAmount} required inputMode="decimal" onChange={(event) => updateLine(index, "discountAmount", event.currentTarget.value)} /></label><button className="button button-secondary" type="button" disabled={lines.length === 1} onClick={() => setLines((current) => current.filter((_, lineIndex) => lineIndex !== index))}>Quitar</button></> : null}
    </div>)}{canManageEconomics ? <button className="button button-secondary" type="button" disabled={references.catalogItems.length === 0 || lines.length >= 50} onClick={() => { const item = references.catalogItems[0]; if (item) setLines((current) => [...current, { catalogItemId: item.id, quantity: "1.000", unitPrice: item.salePrice, discountPercent: "0.00", discountAmount: "0.00" }]); }}>Anadir concepto</button> : <p className="muted">Los conceptos e importes requieren el permiso economico.</p>}</div>
    </fieldset><div className="form-actions"><button className="button" disabled={submitting}>{submitting ? "Guardando..." : "Guardar cambios"}</button>{message ? <p className="message" aria-live="polite">{message}</p> : null}</div>
  </form>;
}

function nullable(value: FormDataEntryValue | null): string | null { const text = String(value ?? "").trim(); return text || null; }
