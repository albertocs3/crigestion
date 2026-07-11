"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type DueDateRow = { dueDate: string; amount: string; paymentMethod: "BANK_TRANSFER" | "CASH" | "DIRECT_DEBIT" };

export function InvoiceDueDatesForm({ invoiceId, total, initialDueDates }: { invoiceId: string; total: string; initialDueDates: DueDateRow[] }) {
  const router = useRouter();
  const [rows, setRows] = useState(initialDueDates);
  const [state, setState] = useState<{ status: "idle" | "saving" | "error" | "success"; message?: string }>({ status: "idle" });
  const assigned = rows.reduce((sum, row) => sum + Math.round(Number(row.amount || 0) * 100), 0);
  const difference = Math.round(Number(total) * 100) - assigned;
  function update(index: number, patch: Partial<DueDateRow>) { setRows((current) => current.map((row, position) => position === index ? { ...row, ...patch } : row)); }
  async function save() {
    setState({ status: "saving" });
    const response = await fetch(`/api/invoices/${invoiceId}/due-dates`, { method: "PUT", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID(), "X-CSRF-Token": await fetchCsrfToken() }, body: JSON.stringify({ dueDates: rows }) });
    if (response.ok) { setState({ status: "success", message: "Vencimientos guardados." }); router.refresh(); return; }
    const body = (await response.json().catch(() => null)) as { message?: string; code?: string } | null;
    setState({ status: "error", message: body?.message ?? body?.code ?? "No se pudieron guardar los vencimientos." });
  }
  return <div className="stack"><div><h2>Editar vencimientos</h2><p className="muted">La suma debe coincidir con el total de la factura.</p></div><div className="compact-stack">{rows.map((row, index) => <fieldset key={index}><legend>Vencimiento {index + 1}</legend><div className="form-three-columns"><label>Fecha<input type="date" value={row.dueDate} onChange={(event) => update(index, { dueDate: event.target.value })} /></label><label>Importe<input inputMode="decimal" value={row.amount} onChange={(event) => update(index, { amount: event.target.value })} /></label><label>Metodo<select value={row.paymentMethod} onChange={(event) => update(index, { paymentMethod: event.target.value as DueDateRow["paymentMethod"] })}><option value="BANK_TRANSFER">Transferencia</option><option value="CASH">Efectivo</option><option value="DIRECT_DEBIT">Domiciliacion</option></select></label></div>{rows.length > 1 ? <button className="button button-secondary button-small" type="button" onClick={() => setRows((current) => current.filter((_, position) => position !== index))}>Quitar</button> : null}</fieldset>)}</div><div className="form-actions"><button className="button button-secondary" type="button" onClick={() => setRows((current) => [...current, { dueDate: current.at(-1)?.dueDate ?? "", amount: "0.00", paymentMethod: current.at(-1)?.paymentMethod ?? "BANK_TRANSFER" }])}>Añadir vencimiento</button><button className="button" type="button" disabled={state.status === "saving" || difference !== 0} onClick={save}>{state.status === "saving" ? "Guardando..." : "Guardar vencimientos"}</button><span className={difference === 0 ? "message" : "message error"}>Diferencia: {(difference / 100).toFixed(2)} €</span>{state.message ? <span className={state.status === "error" ? "message error" : "message"}>{state.message}</span> : null}</div></div>;
}
