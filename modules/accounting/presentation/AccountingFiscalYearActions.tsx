"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type State = { status: "idle" | "submitting" | "success" | "error"; message?: string };

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
  async function close() {
    if (!window.confirm(`Cerrar ${year}, copiar el plan y generar la apertura de ${year + 1}?`)) return;
    setState({ status: "submitting" });
    const response = await fetch(`/api/accounting/fiscal-years/${fiscalYearId}/close`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID(), "X-CSRF-Token": await fetchCsrfToken() } });
    if (response.ok) { setState({ status: "success", message: `Cierre completado. Ejercicio ${year + 1} abierto.` }); router.refresh(); return; }
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    setState({ status: "error", message: body?.message ?? "No se pudo cerrar el ejercicio." });
  }
  return <div className="form-actions"><button className="button button-danger-soft" disabled={state.status === "submitting"} onClick={close} type="button">{state.status === "submitting" ? "Cerrando..." : `Cerrar ${year}`}</button>{state.message ? <span className={state.status === "error" ? "message error" : "message"}>{state.message}</span> : null}</div>;
}
