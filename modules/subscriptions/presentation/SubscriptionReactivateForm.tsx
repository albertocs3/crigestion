"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type Props = {
  subscriptionId: string;
  version: number;
  defaultNextRenewalDate: string;
  minimumNextRenewalDate: string;
  maximumNextRenewalDate: string | null;
};

type PendingConfirmation = {
  nextRenewalDate: string;
  reason: string;
  payload: string;
};

export function SubscriptionReactivateForm({ subscriptionId, version, defaultNextRenewalDate, minimumNextRenewalDate, maximumNextRenewalDate }: Props) {
  const router = useRouter();
  const [nextRenewalDate, setNextRenewalDate] = useState(defaultNextRenewalDate);
  const [reason, setReason] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const confirmationRef = useRef<HTMLDivElement>(null);
  const retry = useRef<{ payload: string; key: string } | null>(null);

  useEffect(() => {
    if (confirmation) confirmationRef.current?.focus();
  }, [confirmation]);

  function prepareConfirmation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    const normalizedReason = reason.trim();
    if (normalizedReason.length < 3) {
      setReasonError("El motivo debe contener al menos 3 caracteres distintos de espacios.");
      return;
    }
    setReasonError(null);
    const payload = JSON.stringify({
      expectedVersion: version,
      nextRenewalDate,
      reason: normalizedReason
    });
    setConfirmation({ nextRenewalDate, reason: normalizedReason, payload });
  }

  async function reactivate() {
    if (!confirmation || submitting) return;
    setSubmitting(true);
    setMessage(null);
    if (!retry.current || retry.current.payload !== confirmation.payload) {
      retry.current = { payload: confirmation.payload, key: crypto.randomUUID() };
    }
    try {
      const csrfToken = await fetchCsrfToken();
      const response = await fetch(`/api/subscriptions/${subscriptionId}/reactivate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": retry.current.key,
          "X-CSRF-Token": csrfToken
        },
        body: confirmation.payload
      });
      const result = (await response.json().catch(() => null)) as { message?: string; code?: string } | null;
      if (!response.ok) {
        setMessage(result?.message ?? result?.code ?? "No se pudo reactivar la suscripcion.");
      } else {
        retry.current = null;
        setMessage("Suscripcion reactivada.");
        router.refresh();
      }
    } catch {
      setMessage("No se pudo conectar con el servidor. Puede reintentar la confirmacion.");
    } finally {
      setSubmitting(false);
    }
  }

  if (confirmation) {
    return <div
      className="form-grid"
      ref={confirmationRef}
      tabIndex={-1}
      role="group"
      aria-labelledby="subscription-reactivation-confirmation-title"
      aria-describedby="subscription-reactivation-confirmation-description"
      aria-busy={submitting}
    >
      <div className="stack">
        <h3 id="subscription-reactivation-confirmation-title">Confirmar reactivacion</h3>
        <p id="subscription-reactivation-confirmation-description" className="message warning">
          La suscripcion volvera a estar activa. La primera renovacion comenzara el {confirmation.nextRenewalDate}; no se facturaran automaticamente periodos anteriores.
        </p>
        <dl className="detail-grid">
          <div><dt>Proxima renovacion</dt><dd>{confirmation.nextRenewalDate}</dd></div>
          <div><dt>Motivo</dt><dd>{confirmation.reason}</dd></div>
        </dl>
      </div>
      <div className="form-actions">
        <button className="button" type="button" disabled={submitting} onClick={reactivate}>
          {submitting ? "Reactivando..." : `Reactivar desde ${confirmation.nextRenewalDate}`}
        </button>
        <button className="button button-secondary" type="button" disabled={submitting} onClick={() => { setConfirmation(null); setMessage(null); }}>
          Volver
        </button>
        {message ? <p className="message error" role="alert">{message}</p> : null}
      </div>
    </div>;
  }

  return <form className="form-grid" onSubmit={prepareConfirmation}>
    <fieldset>
      <legend>Reactivar suscripcion</legend>
      <p id="subscription-reactivation-help" className="message warning">
        Indique cuando debe comenzar el siguiente periodo facturable. La cancelacion y sus motivos se conservaran en el historial.
      </p>
      <label htmlFor="subscription-reactivation-date">Fecha de proxima renovacion
        <input
          id="subscription-reactivation-date"
          name="nextRenewalDate"
          type="date"
          required
          min={minimumNextRenewalDate}
          max={maximumNextRenewalDate ?? undefined}
          value={nextRenewalDate}
          aria-describedby="subscription-reactivation-help"
          onChange={(event) => setNextRenewalDate(event.currentTarget.value)}
        />
      </label>
      <label htmlFor="subscription-reactivation-reason">Motivo de reactivacion
        <textarea
          id="subscription-reactivation-reason"
          name="reason"
          required
          minLength={3}
          maxLength={500}
          value={reason}
          aria-invalid={reasonError ? true : undefined}
          aria-describedby={reasonError ? "subscription-reactivation-reason-error" : undefined}
          onChange={(event) => { setReason(event.currentTarget.value); setReasonError(null); }}
        />
      </label>
      {reasonError ? <p id="subscription-reactivation-reason-error" className="message error" role="alert">{reasonError}</p> : null}
      <label className="checkbox-label" htmlFor="subscription-reactivation-acknowledgement">
        <input
          id="subscription-reactivation-acknowledgement"
          name="acknowledgement"
          type="checkbox"
          required
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.currentTarget.checked)}
        />
        Confirmo que no se facturaran periodos anteriores y que la primera renovacion comenzara en la fecha indicada.
      </label>
    </fieldset>
    <div className="form-actions">
      <button className="button" type="submit">Revisar reactivacion</button>
      {message ? <p className="message" aria-live="polite">{message}</p> : null}
    </div>
  </form>;
}
