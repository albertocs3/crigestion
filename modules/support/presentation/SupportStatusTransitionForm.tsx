"use client";

import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type Status = "NEW" | "IN_PROGRESS" | "PENDING_CUSTOMER" | "PENDING_THIRD_PARTY" | "RESOLVED" | "CLOSED";
type Action = "set-pending-customer" | "set-pending-third-party" | "resume" | "resolve" | "close" | "reopen";

export function SupportStatusTransitionForm({ incidentId, expectedVersion, status, canManage, canReopen }: { incidentId: string; expectedVersion: number; status: Status; canManage: boolean; canReopen: boolean }) {
  const router = useRouter();
  const options = availableActions(status, canManage, canReopen);
  const [action, setAction] = useState<Action>(options[0]?.value ?? "resolve");
  const [state, setState] = useState<{ submitting: boolean; message?: string; error?: boolean }>({ submitting: false });
  const key = useRef<string | null>(null);
  if (options.length === 0) return null;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setState({ submitting: true });
    const form = event.currentTarget; const data = new FormData(form);
    const reason = String(data.get("reason") ?? "").trim(); const solution = String(data.get("solution") ?? "").trim();
    const body = action === "set-pending-customer" || action === "set-pending-third-party"
      ? { action: "set-pending", expectedVersion, targetStatus: action === "set-pending-customer" ? "PENDING_CUSTOMER" : "PENDING_THIRD_PARTY", reason }
      : action === "resume" || action === "reopen" ? { action, expectedVersion, reason }
      : action === "resolve" ? { action, expectedVersion, solution }
      : { action, expectedVersion, closeReason: String(data.get("closeReason")), ...(String(data.get("closeReason")) === "OTHER" ? { detail: String(data.get("detail") ?? "").trim() } : {}) };
    key.current ??= crypto.randomUUID();
    try {
      const response = await fetch(`/api/support/incidents/${incidentId}/status-transitions`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key.current, "X-CSRF-Token": await fetchCsrfToken() }, body: JSON.stringify(body) });
      const result = await response.json().catch(() => null) as { message?: string } | null;
      if (response.ok) { key.current = null; setState({ submitting: false, message: "Estado actualizado." }); router.refresh(); return; }
      if (response.status < 500) key.current = null;
      setState({ submitting: false, error: true, message: result?.message ?? "No se pudo actualizar el estado." });
    } catch { setState({ submitting: false, error: true, message: "Resultado incierto. Reintenta sin cambiar los datos." }); }
  }
  const needsReason = action.startsWith("set-pending") || action === "resume" || action === "reopen";
  return <form className="form-grid" onSubmit={submit}><fieldset disabled={state.submitting}><legend>Cambiar estado</legend><label>Acción<select value={action} onChange={(event) => setAction(event.target.value as Action)}>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>{needsReason ? <label>Motivo<textarea name="reason" required minLength={3} maxLength={500} rows={3}/></label> : null}{action === "resolve" ? <label>Solución<textarea name="solution" required minLength={3} maxLength={4000} rows={5}/></label> : null}{action === "close" ? <><label>Motivo de cierre<select name="closeReason" required><option value="NOT_APPLICABLE">No procede</option><option value="CUSTOMER_WITHDRAWS">Desistimiento del cliente</option><option value="UNREACHABLE">Cliente ilocalizable</option><option value="RESOLVED_EXTERNALLY">Resuelta externamente</option><option value="OTHER">Otros</option></select></label><label>Detalle si seleccionas Otros<input name="detail" minLength={3} maxLength={500}/></label></> : null}<label className="checkbox-row"><input type="checkbox" required/> Confirmo el cambio y su registro permanente en el historial.</label></fieldset><div className="form-actions"><button className="button" disabled={state.submitting}>{state.submitting ? "Guardando…" : "Guardar cambio"}</button>{state.message ? <p role="status" className={state.error ? "message error" : "message"}>{state.message}</p> : null}</div></form>;
}

function availableActions(status: Status, canManage: boolean, canReopen: boolean): Array<{ value: Action; label: string }> {
  if (status === "RESOLVED" || status === "CLOSED") return canReopen ? [{ value: "reopen", label: "Reabrir incidencia" }] : [];
  const values: Array<{ value: Action; label: string }> = [];
  if (!canManage) return values;
  if (status === "PENDING_CUSTOMER" || status === "PENDING_THIRD_PARTY") values.push({ value: "resume", label: "Retomar en curso" });
  values.push({ value: "set-pending-customer", label: "Pendiente del cliente" }, { value: "set-pending-third-party", label: "Pendiente de tercero" }, { value: "resolve", label: "Resolver" }, { value: "close", label: "Cerrar sin resolución ordinaria" });
  return values;
}
