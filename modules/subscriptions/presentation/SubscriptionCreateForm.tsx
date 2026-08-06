"use client";

import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";
import type { SubscriptionReferences } from "@/modules/subscriptions/application/subscriptions";

type Props = SubscriptionReferences & { canManageEconomics: boolean };
type State = { status: "idle" | "submitting" } | { status: "success" | "error"; message: string };

export function SubscriptionCreateForm({ customers, catalogItems, canManageEconomics }: Props) {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: "idle" });
  const retry = useRef<{ payload: string; key: string } | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ status: "submitting" });
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      const csrfToken = await fetchCsrfToken();
      const line: Record<string, string> = {
        catalogItemId: String(data.get("catalogItemId") ?? ""),
        quantity: String(data.get("quantity") ?? "1.000")
      };
      const unitPrice = String(data.get("unitPrice") ?? "").trim();
      if (canManageEconomics && unitPrice) line.unitPrice = unitPrice;
      const payload = JSON.stringify({
        customerId: String(data.get("customerId") ?? ""),
        name: String(data.get("name") ?? ""),
        periodicity: String(data.get("periodicity") ?? "MONTHLY"),
        pricingMode: String(data.get("pricingMode") ?? "FIXED"),
        startDate: String(data.get("startDate") ?? ""),
        endDate: nullableString(data.get("endDate")),
        notes: nullableString(data.get("notes")),
        lines: [line]
      });
      if (!retry.current || retry.current.payload !== payload) retry.current = { payload, key: crypto.randomUUID() };
      const response = await fetch("/api/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": retry.current.key, "X-CSRF-Token": csrfToken },
        body: payload
      });
      const body = (await response.json().catch(() => null)) as { id?: string; message?: string; code?: string } | null;
      if (!response.ok) {
        setState({ status: "error", message: body?.message ?? body?.code ?? "No se pudo crear la suscripcion." });
        return;
      }
      form.reset();
      retry.current = null;
      setState({ status: "success", message: "Suscripcion creada en borrador." });
      if (body?.id) router.push(`/app/subscriptions/${body.id}`);
      else router.refresh();
    } catch {
      setState({ status: "error", message: "No se pudo conectar con el servidor." });
    }
  }

  return (
    <form className="form-grid" onSubmit={handleSubmit}>
      <fieldset>
        <legend>Nueva suscripcion</legend>
        <div className="form-two-columns">
          <label>Cliente<select name="customerId" required defaultValue=""><option value="" disabled>Seleccionar cliente</option>{customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.code} - {customer.legalName}</option>)}</select></label>
          <label>Nombre<input name="name" required minLength={2} maxLength={200} /></label>
          <label>Periodicidad<select name="periodicity" defaultValue="MONTHLY"><option value="MONTHLY">Mensual</option><option value="QUARTERLY">Trimestral</option><option value="SEMIANNUAL">Semestral</option><option value="ANNUAL">Anual</option></select></label>
          <label>Modalidad<select name="pricingMode" defaultValue="FIXED"><option value="FIXED">Importe fijo</option><option value="PER_LICENSE">Por licencias</option></select></label>
          <label>Fecha de inicio<input name="startDate" type="date" required /></label>
          <label>Fecha final<input name="endDate" type="date" /></label>
          <label>Concepto<select name="catalogItemId" required defaultValue=""><option value="" disabled>Seleccionar concepto</option>{catalogItems.map((item) => <option key={item.id} value={item.id}>{item.code} - {item.name} ({item.salePrice} EUR)</option>)}</select></label>
          <label>Cantidad/licencias<input name="quantity" inputMode="decimal" defaultValue="1.000" pattern="[0-9]+([.][0-9]{1,3})?" required /></label>
          {canManageEconomics ? <label>Precio personalizado<input name="unitPrice" inputMode="decimal" pattern="[0-9]+([.][0-9]{1,2})?" placeholder="Usar precio del catalogo" /></label> : null}
          <label>Observaciones<textarea name="notes" maxLength={1000} /></label>
        </div>
      </fieldset>
      <div className="form-actions">
        <button className="button" type="submit" disabled={state.status === "submitting"}>{state.status === "submitting" ? "Creando..." : "Crear borrador"}</button>
        {state.status === "success" || state.status === "error" ? <p className={state.status === "error" ? "message error" : "message"}>{state.message}</p> : null}
      </div>
    </form>
  );
}

function nullableString(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}
