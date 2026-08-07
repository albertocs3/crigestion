"use client";

import { FormEvent, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { AccountingAccountDto } from "@/modules/accounting/application/journal";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type State = { status: "idle" | "submitting" } | { status: "error"; message: string };

export function WaiverEvidenceReplacementRequestForm({ reviewId, accounts }: { reviewId: string; accounts: AccountingAccountDto[] }) {
  const router = useRouter(); const [state, setState] = useState<State>({ status: "idle" });
  const postable = useMemo(() => accounts.filter((account) => account.status === "ACTIVE" && account.isPostable), [accounts]);
  const disabled = state.status === "submitting" || postable.length < 2;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setState({ status: "submitting" }); const data = new FormData(event.currentTarget);
    try {
      const csrf = await fetchCsrfToken(); const concept = String(data.get("concept") ?? ""); const amount = String(data.get("amount") ?? "");
      const response = await fetch(`/api/subscriptions/renewal-waiver-fiscal-reviews/${encodeURIComponent(reviewId)}/accounting-replacements`, {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID(), "X-CSRF-Token": csrf },
        body: JSON.stringify({ expectedReviewVersion: 4, reasonCode: data.get("reasonCode"), reasonDetail: data.get("reasonDetail"),
          accountingDate: data.get("accountingDate"), concept, lines: [
            { accountId: data.get("debitAccountId"), concept, debit: amount, credit: "0.00" },
            { accountId: data.get("creditAccountId"), concept, debit: "0.00", credit: amount }
          ] })
      });
      const payload = await response.json().catch(() => null) as { id?: string; message?: string; code?: string } | null;
      if (!response.ok || !payload?.id) { setState({ status: "error", message: payload?.message ?? payload?.code ?? "No se pudo registrar la propuesta." }); return; }
      router.replace("/app/subscriptions/renewal-waivers"); router.refresh();
    } catch { setState({ status: "error", message: "No se pudo conectar con el servidor." }); }
  }
  return <form className="form-grid" onSubmit={submit}>
    <fieldset disabled={disabled}><legend>Proponer nueva evidencia contable</legend>
      <p className="message warning">La propuesta no genera efectos contables. Un aprobador independiente debe revisar sus cuentas e importes antes de crear el asiento.</p>
      <div className="form-three-columns">
        <label>Fecha contable<input name="accountingDate" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} /></label>
        <label>Motivo<select name="reasonCode" defaultValue="CORRECTED_CLASSIFICATION"><option value="CORRECTED_CLASSIFICATION">Clasificación corregida</option><option value="CORRECTED_AMOUNT">Importe corregido</option><option value="CORRECTED_DATE">Fecha corregida</option><option value="OTHER">Otro</option></select></label>
        <label>Importe<input name="amount" inputMode="decimal" required pattern="\d{1,12}(\.\d{1,2})?" placeholder="121.00" /></label>
      </div>
      <label>Fundamento<textarea name="reasonDetail" required minLength={10} maxLength={500} rows={3} /></label>
      <label>Concepto del asiento<input name="concept" required minLength={2} maxLength={240} /></label>
      <div className="form-two-columns">
        <label>Cuenta debe<select name="debitAccountId" required defaultValue=""><option value="" disabled>Selecciona cuenta</option>{postable.map((account) => <option key={account.id} value={account.id}>{account.code} - {account.name}</option>)}</select></label>
        <label>Cuenta haber<select name="creditAccountId" required defaultValue=""><option value="" disabled>Selecciona cuenta</option>{postable.map((account) => <option key={account.id} value={account.id}>{account.code} - {account.name}</option>)}</select></label>
      </div>
    </fieldset>
    {postable.length < 2 ? <p className="message error">No hay suficientes cuentas imputables activas.</p> : null}
    <div className="form-actions"><button className="button" type="submit" disabled={disabled}>{state.status === "submitting" ? "Registrando..." : "Registrar propuesta"}</button>
      {state.status === "error" ? <p role="alert" className="message error">{state.message}</p> : null}</div>
  </form>;
}
