"use client";

import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type MergeCandidate = {
  id: string;
  number: string;
  title: string;
  version: number;
};

export function SupportIncidentMergeForm({
  duplicateIncident,
  candidates,
}: {
  duplicateIncident: { id: string; number: string; version: number };
  candidates: MergeCandidate[];
}) {
  const router = useRouter();
  const [primaryIncidentId, setPrimaryIncidentId] = useState(candidates[0]?.id ?? "");
  const [state, setState] = useState<{
    submitting: boolean;
    message?: string;
    error?: boolean;
  }>({ submitting: false });
  const key = useRef<string | null>(null);
  const selected = candidates.find((candidate) => candidate.id === primaryIncidentId);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    setState({ submitting: true });
    const data = new FormData(event.currentTarget);
    const body = {
      primaryIncidentId: selected.id,
      duplicateIncidentId: duplicateIncident.id,
      expectedPrimaryVersion: selected.version,
      expectedDuplicateVersion: duplicateIncident.version,
      reason: String(data.get("reason") ?? "").trim(),
      confirmation: "MERGE_DUPLICATE_INCIDENT",
    };
    key.current ??= crypto.randomUUID();
    try {
      const response = await fetch("/api/support/incident-merges", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": key.current,
          "X-CSRF-Token": await fetchCsrfToken(),
        },
        body: JSON.stringify(body),
      });
      const result = (await response.json().catch(() => null)) as {
        message?: string;
      } | null;
      if (response.ok) {
        key.current = null;
        setState({ submitting: false, message: "Incidencia fusionada." });
        router.refresh();
        return;
      }
      if (response.status < 500) key.current = null;
      setState({
        submitting: false,
        error: true,
        message: result?.message ?? "No se pudo fusionar la incidencia.",
      });
    } catch {
      setState({
        submitting: false,
        error: true,
        message:
          "Resultado incierto. Reintenta sin cambiar los datos para reutilizar la clave idempotente.",
      });
    }
  }

  return (
    <form className="form-grid" onSubmit={submit}>
      <fieldset disabled={state.submitting || candidates.length === 0}>
        <legend>Fusionar incidencia duplicada</legend>
        {candidates.length === 0 ? (
          <p className="muted">
            No hay otras incidencias del mismo cliente disponibles como principal.
          </p>
        ) : (
          <>
            <label>
              Incidencia principal
              <select
                name="primaryIncidentId"
                required
                value={primaryIncidentId}
                aria-describedby="incident-merge-warning"
                onChange={(event) => {
                  setPrimaryIncidentId(event.target.value);
                  setState({ submitting: false });
                }}
              >
                {candidates.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.number} · {candidate.title}
                  </option>
                ))}
              </select>
            </label>
            {selected ? (
              <dl className="detail-grid">
                <div>
                  <dt>Principal seleccionada</dt>
                  <dd>{selected.number}</dd>
                </div>
                <div>
                  <dt>Título</dt>
                  <dd>{selected.title}</dd>
                </div>
              </dl>
            ) : null}
            <label>
              Motivo
              <textarea name="reason" required minLength={3} maxLength={500} rows={3} />
            </label>
            <p id="incident-merge-warning" className="message">
              La incidencia duplicada se cerrará permanentemente. Su contenido seguirá en su
              registro y podrá consultarse desde la principal.
            </p>
            <label className="checkbox-row">
              <input type="checkbox" required /> Confirmo que {duplicateIncident.number} es
              duplicada de {selected?.number} y que la fusión quedará registrada
              permanentemente.
            </label>
          </>
        )}
      </fieldset>
      <div className="form-actions">
        <button
          className="button"
          type="submit"
          disabled={state.submitting || candidates.length === 0 || !selected}
        >
          {state.submitting ? "Fusionando…" : "Fusionar como duplicada"}
        </button>
        {state.message ? (
          <p role="status" className={state.error ? "message error" : "message"}>
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}
