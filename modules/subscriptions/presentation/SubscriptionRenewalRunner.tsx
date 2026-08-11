"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { SubscriptionRenewalPreview } from "@/modules/subscriptions/application/renewals";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

export function SubscriptionRenewalRunner({ preview, canConfirm, canExclude }: { preview: SubscriptionRenewalPreview; canConfirm: boolean; canExclude: boolean }) {
  const router = useRouter();
  const keys = useRef(new Map<string, { fingerprint: string; key: string }>());
  const [selected, setSelected] = useState<Record<string, string[]>>(() => Object.fromEntries(preview.groups.map((group) => [group.key, group.subscriptions.map((subscription) => subscription.id)])));
  const [lineDescriptions, setLineDescriptions] = useState<Record<string, string>>(() => Object.fromEntries(
    preview.groups.flatMap((group) => group.subscriptions.flatMap((subscription) => subscription.lines.map((line) => [line.id, line.description])))
  ));
  const [releaseReasons, setReleaseReasons] = useState<Record<string, string>>({});
  const [exclusionReasons, setExclusionReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  function keyFor(action: string, body: unknown) {
    const fingerprint = JSON.stringify(body);
    const existing = keys.current.get(action);
    if (existing?.fingerprint === fingerprint) return existing.key;
    const key = crypto.randomUUID(); keys.current.set(action, { fingerprint, key }); return key;
  }
  async function mutate(path: string, body: unknown, action: string) {
    setBusy(action); setMessage(null);
    try {
      const csrfToken = await fetchCsrfToken();
      const response = await fetch(path, { method: "POST", headers: {
        "Content-Type": "application/json", "X-CSRF-Token": csrfToken, "Idempotency-Key": keyFor(action, body)
      }, body: JSON.stringify(body) });
      const value = await response.json().catch(() => null) as { message?: string; code?: string; invoiceId?: string; number?: string; cancelledSubscriptionIds?: string[] } | null;
      if (!response.ok) { setMessage(value?.message ?? value?.code ?? "No se pudo completar la operacion."); return; }
      keys.current.delete(action);
      if (action.startsWith("prepare:")) {
        setMessage(value?.invoiceId ? "Vista previa reservada. Revise la factura antes de confirmarla." : `Se aplicaron ${value?.cancelledSubscriptionIds?.length ?? 0} bajas; no se genero factura.`);
      } else if (action.startsWith("confirm:")) setMessage(`Renovacion confirmada${value?.number ? ` como ${value.number}` : ""}.`);
      else if (action.startsWith("exclude:")) setMessage("Renovacion excluida y trasladada a pendientes.");
      else setMessage("Reserva liberada; las suscripciones vuelven a estar disponibles.");
      router.refresh();
    } catch { setMessage("No se pudo conectar con el servidor. Puede reintentar sin duplicar efectos."); }
    finally { setBusy(null); }
  }

  return <div className="stack">
    {message ? <p className="message" aria-live="polite">{message}</p> : null}
    <section className="panel stack">
      <div><h2>Candidatos agrupados</h2><p className="muted">La selección es orientativa. Al preparar se revalidan estado, versión, periodo, cliente y bajas programadas.</p></div>
      {preview.groups.length === 0 ? <p>No hay renovaciones disponibles para esta fecha.</p> : preview.groups.map((group) => {
        const selectedIds = selected[group.key] ?? [];
        const selectedSubscriptions = group.subscriptions.filter((subscription) => selectedIds.includes(subscription.id));
        const hasInvalidDescription = selectedSubscriptions.some((subscription) => subscription.action === "INVOICE"
          && subscription.lines.some((line) => (lineDescriptions[line.id] ?? line.description).trim().length === 0));
        const descriptionOverrideCount = selectedSubscriptions.reduce((count, subscription) => count + subscription.lines.filter((line) =>
          (lineDescriptions[line.id] ?? line.description).trim() !== line.description).length, 0);
        const hasTooManyDescriptionOverrides = descriptionOverrideCount > 100;
        const action = `prepare:${group.key}`;
        return <article className="panel stack" key={group.key}>
          <div className="filter-row"><div><strong>{group.customer.legalName}</strong><span className="cell-detail">{group.customer.code} · {paymentLabel(group.paymentMethod)} · periodo {group.periodStart}</span></div><div><strong>{group.estimatedTotal} EUR</strong><span className="cell-detail">estimación facturable</span></div></div>
          {!group.selectable ? <p className="message error">El grupo supera 100 suscripciones y no puede prepararse en este corte.</p> : null}
          <div className="table-wrap"><table><thead><tr><th scope="col">Incluir</th><th scope="col">Suscripción</th><th scope="col">Estado</th><th scope="col">Acción prevista</th><th scope="col">Estimación</th><th scope="col">Descripción para esta factura</th><th scope="col">Gestión</th></tr></thead><tbody>
            {group.subscriptions.map((subscription) => {
              const exclusionReason = exclusionReasons[subscription.id] ?? "";
              const excludeAction = `exclude:${subscription.id}`;
              return <tr key={subscription.id}>
              <td><input aria-label={`Incluir ${subscription.number}`} type="checkbox" checked={selectedIds.includes(subscription.id)} disabled={!group.selectable || busy !== null} onChange={(event) => setSelected((current) => ({ ...current, [group.key]: event.target.checked ? [...(current[group.key] ?? []), subscription.id] : (current[group.key] ?? []).filter((id) => id !== subscription.id) }))} /></td>
              <td><strong>{subscription.number}</strong><span className="cell-detail">{subscription.name}</span></td>
              <td>{subscription.status === "ACTIVE" ? "Activa" : <><strong>Pendiente</strong><span className="cell-detail">{subscription.pending?.reason ?? (subscription.pending?.hasReason ? "Motivo restringido" : pendingReasonLabel(subscription.pending?.reasonCode))}</span><span className="cell-detail">Abierta por {subscription.pending?.excludedBy?.displayName ?? "sistema"} · {subscription.pending ? operationalDate(subscription.pending.excludedAt) : ""}</span><span className="cell-detail">Preparaciones: {subscription.pending?.attemptCount ?? 0}{subscription.pending?.lastErrorCode ? ` · ${subscription.pending.lastErrorCode}` : ""}</span></>}</td>
              <td>{subscription.action === "CANCEL" ? "Aplicar baja vencida; no facturar" : "Reservar para factura"}</td>
              <td>{subscription.action === "CANCEL" ? "—" : `${subscription.estimatedTotal} EUR`}</td>
              <td>{subscription.action === "CANCEL" ? <span className="muted">—</span> : <div className="stack">{subscription.lines.map((line) => <label key={line.id} htmlFor={`renewal-description-${line.id}`}>Línea {line.position}
                <input id={`renewal-description-${line.id}`} type="text" maxLength={500} value={lineDescriptions[line.id] ?? line.description} disabled={busy !== null || !selectedIds.includes(subscription.id)}
                  onChange={(event) => setLineDescriptions((current) => ({ ...current, [line.id]: event.target.value }))} />
              </label>)}</div>}</td>
              <td>{canExclude && subscription.status === "ACTIVE" && subscription.action !== "CANCEL" ? <div className="stack">
                <label>Motivo de exclusión<span className="cell-detail">Entre 3 y 500 caracteres</span><input type="text" maxLength={500} value={exclusionReason} disabled={busy !== null} onChange={(event) => setExclusionReasons((current) => ({ ...current, [subscription.id]: event.target.value }))} /></label>
                <button className="button button-secondary" type="button" disabled={busy !== null || exclusionReason.trim().length < 3} onClick={() => {
                  if (!window.confirm(`Excluir la renovación ${subscription.number} del periodo ${group.periodStart}?`)) return;
                  void mutate(`/api/subscriptions/${subscription.id}/renewal-exclusions`, {
                    expectedVersion: subscription.version, periodStart: group.periodStart, processDate: preview.processDate, reason: exclusionReason.trim()
                  }, excludeAction);
                }}>{busy === excludeAction ? "Excluyendo..." : "Excluir explícitamente"}</button>
              </div> : <span className="muted">—</span>}</td>
            </tr>})}</tbody></table></div>
          {hasInvalidDescription ? <p className="message error">Las descripciones de las líneas seleccionadas no pueden quedar vacías.</p> : null}
          {hasTooManyDescriptionOverrides ? <p className="message error">Solo se pueden personalizar 100 descripciones por preparación.</p> : null}
          <button className="button" type="button" disabled={!group.selectable || selectedIds.length === 0 || hasInvalidDescription || hasTooManyDescriptionOverrides || busy !== null} onClick={() => {
            const subscriptions = selectedSubscriptions.map((subscription) => ({
              subscriptionId: subscription.id, expectedVersion: subscription.version,
              ...(subscription.pending ? { pendingExclusionId: subscription.pending.exclusionId } : {}),
              lineDescriptionOverrides: subscription.lines.flatMap((line) => {
                const description = (lineDescriptions[line.id] ?? line.description).trim();
                return description !== line.description ? [{ subscriptionLineId: line.id, description }] : [];
              })
            }));
            void mutate("/api/subscriptions/renewals", { subscriptions, issueDate: preview.processDate }, action);
          }}>{busy === action ? "Preparando..." : "Preparar selección"}</button>
        </article>;
      })}
    </section>
    <section className="panel stack">
      <div><h2>Facturas reservadas</h2><p className="muted">Confirmar emite factura y asiento. Liberar conserva el historial y desbloquea las suscripciones.</p></div>
      {preview.reservedInvoices.length === 0 ? <p>No hay facturas de renovación pendientes.</p> : <div className="table-wrap"><table><thead><tr><th>Cliente</th><th>Fecha</th><th>Suscripciones</th><th>Total</th><th>Acciones</th></tr></thead><tbody>{preview.reservedInvoices.map((invoice) => {
        const confirmAction = `confirm:${invoice.invoiceId}`; const releaseAction = `release:${invoice.invoiceId}`;
        const releaseReason = releaseReasons[invoice.invoiceId] ?? "";
        return <tr key={invoice.invoiceId}><td><strong>{invoice.customer.legalName}</strong><span className="cell-detail">{invoice.customer.code}</span></td><td>{invoice.issueDate}</td><td>{invoice.subscriptionCount}</td><td>{invoice.total} EUR</td><td><div className="stack">
          {canConfirm ? <button className="button" type="button" disabled={busy !== null} onClick={() => void mutate(`/api/subscriptions/renewals/${invoice.invoiceId}/confirm`, {}, confirmAction)}>{busy === confirmAction ? "Confirmando..." : "Confirmar y emitir"}</button> : <span className="muted">Sin permiso de emisión</span>}
          <label>Motivo para liberar<span className="cell-detail">Obligatorio, entre 3 y 500 caracteres</span><input type="text" value={releaseReason} maxLength={500} disabled={busy !== null} onChange={(event) => setReleaseReasons((current) => ({ ...current, [invoice.invoiceId]: event.target.value }))} /></label>
          <button className="button button-secondary" type="button" disabled={busy !== null || releaseReason.trim().length < 3} onClick={() => void mutate(`/api/subscriptions/renewals/${invoice.invoiceId}/release`, { reason: releaseReason.trim() }, releaseAction)}>{busy === releaseAction ? "Liberando..." : "Liberar reserva"}</button>
        </div></td></tr>;
      })}</tbody></table></div>}
    </section>
  </div>;
}

function paymentLabel(value: string) { return ({ BANK_TRANSFER: "Transferencia", CASH: "Efectivo", DIRECT_DEBIT: "Domiciliación" } as Record<string, string>)[value] ?? value; }
function operationalDate(value: string) { return new Intl.DateTimeFormat("es-ES", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Madrid" }).format(new Date(value)); }
function pendingReasonLabel(value?: string) { return value === "PREPARATION_FAILED" ? "Bloqueo automático de preparación" : value === "LEGACY_PENDING" ? "Pendiente migrada" : "Sin detalle"; }
