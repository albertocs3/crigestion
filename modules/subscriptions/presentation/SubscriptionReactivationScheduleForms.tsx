"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";
import type { SubscriptionReactivationScheduleDto } from "@/modules/subscriptions/application/reactivationSchedules";

type Props = {
  subscriptionId: string;
  subscriptionVersion: number;
  businessDate: string;
  minimumEffectiveDate: string;
  maximumEffectiveDate: string | null;
  defaultNextRenewalDate: string;
  pendingSchedule: SubscriptionReactivationScheduleDto | null;
};

type Confirmation = {
  effectiveDate: string;
  nextRenewalDate: string;
  reason: string;
  payload: string;
};

export function SubscriptionReactivationScheduleForms(props: Props) {
  return props.pendingSchedule
    ? <PendingSchedule {...props} schedule={props.pendingSchedule} />
    : <CreateSchedule {...props} />;
}

function CreateSchedule({ subscriptionId, subscriptionVersion, minimumEffectiveDate, maximumEffectiveDate, defaultNextRenewalDate }: Props) {
  const router = useRouter();
  const [effectiveDate, setEffectiveDate] = useState(minimumEffectiveDate);
  const [nextRenewalDate, setNextRenewalDate] = useState(defaultNextRenewalDate < minimumEffectiveDate ? minimumEffectiveDate : defaultNextRenewalDate);
  const [reason, setReason] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const confirmationRef = useRef<HTMLDivElement>(null);
  const reviewButtonRef = useRef<HTMLButtonElement>(null);
  const retry = useRef<{ payload: string; key: string } | null>(null);

  useEffect(() => {
    if (confirmation) confirmationRef.current?.focus();
  }, [confirmation]);

  function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    const normalizedReason = reason.trim();
    if (normalizedReason.length < 3) {
      setReasonError("El motivo debe contener al menos 3 caracteres distintos de espacios.");
      return;
    }
    setReasonError(null);
    const payload = JSON.stringify({ expectedVersion: subscriptionVersion, effectiveDate, nextRenewalDate, reason: normalizedReason });
    setConfirmation({ effectiveDate, nextRenewalDate, reason: normalizedReason, payload });
  }

  async function create() {
    if (!confirmation || submitting) return;
    setSubmitting(true);
    setMessage(null);
    if (!retry.current || retry.current.payload !== confirmation.payload) retry.current = { payload: confirmation.payload, key: crypto.randomUUID() };
    try {
      const csrf = await fetchCsrfToken();
      const response = await fetch(`/api/subscriptions/${subscriptionId}/reactivation-schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": retry.current.key, "X-CSRF-Token": csrf },
        body: confirmation.payload
      });
      const result = (await response.json().catch(() => null)) as { message?: string; code?: string } | null;
      if (!response.ok) setMessage(result?.message ?? result?.code ?? "No se pudo programar la reactivacion.");
      else { retry.current = null; setMessage("Reactivacion programada."); router.refresh(); }
    } catch {
      setMessage("No se pudo conectar con el servidor. Puede reintentar la confirmacion.");
    } finally {
      setSubmitting(false);
    }
  }

  if (confirmation) return <div
    className="form-grid"
    ref={confirmationRef}
    tabIndex={-1}
    role="group"
    aria-labelledby="subscription-reactivation-schedule-confirmation-title"
    aria-describedby="subscription-reactivation-schedule-confirmation-description"
    aria-busy={submitting}
  >
    <div className="stack">
      <h3 id="subscription-reactivation-schedule-confirmation-title">Confirmar reactivacion programada</h3>
      <p id="subscription-reactivation-schedule-confirmation-description" className="message warning">
        La suscripcion permanecera cancelada hasta que esta orden se aplique en la fecha prevista o posteriormente mediante el proceso supervisado.
      </p>
      <dl className="detail-grid">
        <div><dt>Fecha efectiva</dt><dd>{confirmation.effectiveDate}</dd></div>
        <div><dt>Proxima renovacion</dt><dd>{confirmation.nextRenewalDate}</dd></div>
        <div><dt>Motivo</dt><dd>{confirmation.reason}</dd></div>
      </dl>
    </div>
    <div className="form-actions">
      <button className="button" type="button" disabled={submitting} onClick={create}>{submitting ? "Programando..." : `Programar para ${confirmation.effectiveDate}`}</button>
      <button className="button button-secondary" type="button" disabled={submitting} onClick={() => { setConfirmation(null); setMessage(null); requestAnimationFrame(() => reviewButtonRef.current?.focus()); }}>Volver</button>
      {message ? <p className="message error" role="alert">{message}</p> : null}
    </div>
  </div>;

  return <form className="form-grid" onSubmit={prepare}>
    <fieldset>
      <legend>Programar reactivacion</legend>
      <p id="subscription-reactivation-schedule-help" className="message warning">
        La orden no activa la suscripcion por si sola. En la fecha prevista debera aplicarse mediante el proceso supervisado.
      </p>
      <div className="form-two-columns">
        <label htmlFor="subscription-reactivation-schedule-effective-date">Fecha efectiva
          <input
            id="subscription-reactivation-schedule-effective-date"
            name="effectiveDate"
            type="date"
            required
            min={minimumEffectiveDate}
            max={maximumEffectiveDate ?? undefined}
            value={effectiveDate}
            aria-describedby="subscription-reactivation-schedule-help"
            onChange={(event) => {
              const value = event.currentTarget.value;
              setEffectiveDate(value);
              if (nextRenewalDate < value) setNextRenewalDate(value);
            }}
          />
        </label>
        <label htmlFor="subscription-reactivation-schedule-renewal-date">Fecha de proxima renovacion
          <input
            id="subscription-reactivation-schedule-renewal-date"
            name="nextRenewalDate"
            type="date"
            required
            min={effectiveDate}
            max={maximumEffectiveDate ?? undefined}
            value={nextRenewalDate}
            onChange={(event) => setNextRenewalDate(event.currentTarget.value)}
          />
        </label>
      </div>
      <label htmlFor="subscription-reactivation-schedule-reason">Motivo de la programacion
        <textarea
          id="subscription-reactivation-schedule-reason"
          name="reason"
          required
          minLength={3}
          maxLength={500}
          value={reason}
          aria-invalid={reasonError ? true : undefined}
          aria-describedby={reasonError ? "subscription-reactivation-schedule-reason-error" : undefined}
          onChange={(event) => { setReason(event.currentTarget.value); setReasonError(null); }}
        />
      </label>
      {reasonError ? <p id="subscription-reactivation-schedule-reason-error" className="message error" role="alert">{reasonError}</p> : null}
      <label className="checkbox-label" htmlFor="subscription-reactivation-schedule-acknowledgement">
        <input
          id="subscription-reactivation-schedule-acknowledgement"
          name="acknowledgement"
          type="checkbox"
          required
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.currentTarget.checked)}
        />
        Confirmo que la suscripcion permanecera cancelada hasta que esta programacion se aplique de forma supervisada.
      </label>
    </fieldset>
    <div className="form-actions"><button ref={reviewButtonRef} className="button button-secondary" type="submit">Revisar programacion</button></div>
  </form>;
}

function PendingSchedule({ subscriptionId, subscriptionVersion, businessDate, schedule }: Props & { schedule: SubscriptionReactivationScheduleDto }) {
  const router = useRouter();
  const [action, setAction] = useState<"apply" | "cancel" | null>(null);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const confirmationRef = useRef<HTMLDivElement>(null);
  const applyButtonRef = useRef<HTMLButtonElement>(null);
  const cancelReviewButtonRef = useRef<HTMLButtonElement>(null);
  const retry = useRef<{ action: "apply" | "cancel"; payload: string; key: string } | null>(null);
  const due = schedule.effectiveDate <= businessDate;
  const renewalDatePassed = schedule.nextRenewalDate < businessDate;
  const applicable = due && !renewalDatePassed;

  useEffect(() => {
    if (action) confirmationRef.current?.focus();
  }, [action]);

  function prepareCancellation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedReason = reason.trim();
    if (normalizedReason.length < 3) {
      setReasonError("El motivo debe contener al menos 3 caracteres distintos de espacios.");
      return;
    }
    setReasonError(null);
    setMessage(null);
    setAction("cancel");
  }

  async function submitAction() {
    if (!action || submitting) return;
    const payload = action === "apply"
      ? JSON.stringify({ expectedSubscriptionVersion: subscriptionVersion, expectedScheduleVersion: schedule.version })
      : JSON.stringify({ expectedSubscriptionVersion: subscriptionVersion, expectedScheduleVersion: schedule.version, reason: reason.trim() });
    if (!retry.current || retry.current.action !== action || retry.current.payload !== payload) retry.current = { action, payload, key: crypto.randomUUID() };
    setSubmitting(true);
    setMessage(null);
    try {
      const csrf = await fetchCsrfToken();
      const suffix = action === "apply" ? "apply" : "cancel";
      const response = await fetch(`/api/subscriptions/${subscriptionId}/reactivation-schedules/${schedule.id}/${suffix}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": retry.current.key, "X-CSRF-Token": csrf },
        body: payload
      });
      const result = (await response.json().catch(() => null)) as { message?: string; code?: string } | null;
      if (!response.ok) setMessage(result?.message ?? result?.code ?? (action === "apply" ? "No se pudo aplicar la reactivacion." : "No se pudo retirar la programacion."));
      else { retry.current = null; setMessage(action === "apply" ? "Reactivacion aplicada." : "Programacion retirada."); router.refresh(); }
    } catch {
      setMessage("No se pudo conectar con el servidor. Puede reintentar la confirmacion.");
    } finally {
      setSubmitting(false);
    }
  }

  if (action) return <div
    className="form-grid"
    ref={confirmationRef}
    tabIndex={-1}
    role="group"
    aria-labelledby="subscription-reactivation-schedule-action-title"
    aria-describedby="subscription-reactivation-schedule-action-description"
    aria-busy={submitting}
  >
    <div className="stack">
      <h3 id="subscription-reactivation-schedule-action-title">{action === "apply" ? "Confirmar aplicacion" : "Confirmar retirada"}</h3>
      <p id="subscription-reactivation-schedule-action-description" className="message warning">
        {action === "apply"
          ? `La suscripcion quedara activa y su proxima renovacion sera el ${schedule.nextRenewalDate}.`
          : "La suscripcion seguira cancelada y la orden retirada se conservara en el historial."}
      </p>
    </div>
    <div className="form-actions">
      <button className="button" type="button" disabled={submitting} onClick={submitAction}>{submitting ? "Guardando..." : action === "apply" ? "Aplicar reactivacion" : "Retirar programacion"}</button>
      <button className="button button-secondary" type="button" disabled={submitting} onClick={() => {
        const previousAction = action;
        setAction(null);
        setMessage(null);
        requestAnimationFrame(() => (previousAction === "apply" ? applyButtonRef.current : cancelReviewButtonRef.current)?.focus());
      }}>Volver</button>
      {message ? <p className="message error" role="alert">{message}</p> : null}
    </div>
  </div>;

  return <div className="form-grid">
    <div className="stack">
      <h2>Reactivacion programada</h2>
      <p className={due ? "message warning" : "message"}>
        {renewalDatePassed
          ? "La fecha de renovacion ha quedado atras. Retire esta programacion y cree otra con una fecha valida."
          : due ? "Pendiente de aplicacion; la fecha prevista ya ha llegado." : "Pendiente de aplicacion."}
      </p>
      <dl className="detail-grid">
        <div><dt>Fecha efectiva</dt><dd>{schedule.effectiveDate}</dd></div>
        <div><dt>Proxima renovacion</dt><dd>{schedule.nextRenewalDate}</dd></div>
        <div><dt>Motivo</dt><dd>{schedule.reason}</dd></div>
        <div><dt>Registrada</dt><dd>{new Date(schedule.requestedAt).toLocaleString("es-ES")}</dd></div>
      </dl>
    </div>
    {applicable ? <div className="form-actions"><button ref={applyButtonRef} className="button" type="button" onClick={() => { setAction("apply"); setMessage(null); }}>Aplicar reactivacion</button></div> : null}
    <form className="form-grid" onSubmit={prepareCancellation}>
      <fieldset disabled={submitting}>
        <legend>Retirar programacion</legend>
        <label htmlFor="subscription-reactivation-schedule-cancel-reason">Motivo de retirada
          <textarea
            id="subscription-reactivation-schedule-cancel-reason"
            name="reason"
            required
            minLength={3}
            maxLength={500}
            value={reason}
            aria-invalid={reasonError ? true : undefined}
            aria-describedby={reasonError ? "subscription-reactivation-schedule-cancel-reason-error" : undefined}
            onChange={(event) => { setReason(event.currentTarget.value); setReasonError(null); }}
          />
        </label>
        {reasonError ? <p id="subscription-reactivation-schedule-cancel-reason-error" className="message error" role="alert">{reasonError}</p> : null}
      </fieldset>
      <div className="form-actions"><button ref={cancelReviewButtonRef} className="button button-secondary" type="submit">Revisar retirada</button></div>
    </form>
  </div>;
}
