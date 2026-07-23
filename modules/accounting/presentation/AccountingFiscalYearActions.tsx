"use client";

import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type State = { status: "idle" | "submitting" | "success" | "error"; message?: string };
type ClosePreflight = {
  unbalancedEntryCount: number;
  headerLineMismatchCount: number;
  invalidEntryShapeCount: number;
  invalidLineCount: number;
  crossFiscalYearLineCount: number;
  draftInvoiceCount: number;
  invoiceWithoutEntryCount: number;
  unresolvedVerifactuInvoiceCount: number;
  draftPurchaseCount: number;
  purchaseWithoutEntryCount: number;
  pendingCustomerRefundCount: number;
  pendingSupplierRefundCount: number;
  unsupportedAccountBalanceCount: number;
  resultAccountReady: boolean;
};

export function AccountingFiscalYearCreateForm({ defaultYear }: { defaultYear: number }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: "idle" });
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ status: "submitting" });
    const data = new FormData(event.currentTarget);
    const response = await fetch("/api/accounting/fiscal-years", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID(), "X-CSRF-Token": await fetchCsrfToken() },
      body: JSON.stringify({ year: String(data.get("year") ?? "") })
    });
    if (response.ok) { setState({ status: "success", message: "Contabilidad creada con el PGC PYMES." }); router.refresh(); return; }
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    setState({ status: "error", message: body?.message ?? "No se pudo crear la contabilidad." });
  }
  return <form className="form-grid" onSubmit={submit}><fieldset><legend>Crear primera contabilidad</legend><p className="muted">Se creara el ejercicio y se cargara el PGC PYMES con subcuentas operativas.</p><label>Ejercicio<input name="year" type="number" min={2000} max={2100} defaultValue={defaultYear} required /></label></fieldset><div className="form-actions"><button className="button" disabled={state.status === "submitting"} type="submit">{state.status === "submitting" ? "Creando..." : "Crear contabilidad"}</button>{state.message ? <p className={state.status === "error" ? "message error" : "message"}>{state.message}</p> : null}</div></form>;
}

export function AccountingFiscalYearCloseButton({ fiscalYearId, year }: { fiscalYearId: string; year: number }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: "idle" });
  const idempotencyKey = useRef<string | null>(null);
  async function close() {
    if (!window.confirm(`Cerrar ${year}, copiar el plan y generar la apertura de ${year + 1}?`)) return;
    setState({ status: "submitting" });
    idempotencyKey.current ??= crypto.randomUUID();
    try {
      const response = await fetch(`/api/accounting/fiscal-years/${fiscalYearId}/close`, { method: "POST", headers: { "Idempotency-Key": idempotencyKey.current, "X-CSRF-Token": await fetchCsrfToken() } });
      const body = (await response.json().catch(() => null)) as { message?: string; preflight?: ClosePreflight } | null;
      if (response.ok) {
        idempotencyKey.current = null;
        setState({ status: "success", message: `Cierre completado. Ejercicio ${year + 1} abierto.` });
        router.refresh();
        return;
      }
      setState({
        status: "error",
        message: body?.preflight
          ? formatClosePreflight(body.preflight)
          : body?.message ?? "No se pudo cerrar el ejercicio."
      });
    } catch {
      setState({
        status: "error",
        message: "Resultado incierto. Reintenta para reutilizar la misma clave idempotente."
      });
    }
  }
  return <div className="form-actions"><button className="button button-danger-soft" disabled={state.status === "submitting"} onClick={close} type="button">{state.status === "submitting" ? "Cerrando..." : `Cerrar ${year}`}</button>{state.message ? <span className={state.status === "error" ? "message error" : "message"}>{state.message}</span> : null}</div>;
}

function formatClosePreflight(report: ClosePreflight): string {
  const blockers = [
    [report.unbalancedEntryCount, "asientos descuadrados"],
    [report.headerLineMismatchCount, "asientos con totales incoherentes"],
    [report.invalidEntryShapeCount, "asientos con estructura invalida"],
    [report.invalidLineCount, "lineas de diario invalidas"],
    [report.crossFiscalYearLineCount, "lineas vinculadas a otro ejercicio"],
    [report.draftInvoiceCount, "facturas de venta en borrador"],
    [report.invoiceWithoutEntryCount, "facturas de venta sin asiento"],
    [report.unresolvedVerifactuInvoiceCount, "facturas con VeriFactu pendiente"],
    [report.draftPurchaseCount, "compras en borrador"],
    [report.purchaseWithoutEntryCount, "compras sin asiento"],
    [report.pendingCustomerRefundCount, "devoluciones a clientes pendientes"],
    [report.pendingSupplierRefundCount, "devoluciones a proveedores pendientes"],
    [report.unsupportedAccountBalanceCount, "cuentas de grupos 0/8/9 con saldo"]
  ] as const;
  const messages = blockers
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}`);
  if (!report.resultAccountReady) messages.push("falta la cuenta 129000000 activa y contabilizable");
  return `Cierre bloqueado: ${messages.join("; ")}.`;
}
