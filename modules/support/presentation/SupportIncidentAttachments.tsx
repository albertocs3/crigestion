"use client";

import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";
import type { SupportIncidentAttachmentDto } from "@/modules/support/application/incidentAttachments";

export function SupportIncidentAttachments({ incidentId, attachments, nextCursor, canUpload, canDownload }: { incidentId: string; attachments: SupportIncidentAttachmentDto[]; nextCursor: string | null; canUpload: boolean; canDownload: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<{ busy: boolean; message?: string; error?: boolean }>({ busy: false });
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const idempotencyKey = useRef<string | null>(null);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); const file = data.get("file");
    if (!(file instanceof File) || file.size < 1) { setState({ busy: false, error: true, message: "Selecciona un archivo JPG o PDF." }); return; }
    if (file.size > 16 * 1024 * 1024) { setState({ busy: false, error: true, message: "El archivo no puede superar 16 MiB." }); return; }
    idempotencyKey.current ??= crypto.randomUUID(); setState({ busy: true });
    try {
      const response = await fetch(`/api/support/incidents/${incidentId}/attachments`, { method: "POST", headers: { "Idempotency-Key": idempotencyKey.current, "X-CSRF-Token": await fetchCsrfToken() }, body: data });
      const result = await response.json().catch(() => null) as { message?: string } | null;
      if (response.ok) { idempotencyKey.current = null; form.reset(); setState({ busy: false, message: "Archivo adjuntado y analizado correctamente." }); router.replace(`/app/support/incidents/${incidentId}`); router.refresh(); return; }
      if (response.status < 500 && response.status !== 429) idempotencyKey.current = null;
      setState({ busy: false, error: true, message: result?.message ?? (response.status >= 500 ? "Resultado incierto. Reintenta sin cambiar el archivo." : "No se pudo adjuntar el archivo.") });
    } catch { setState({ busy: false, error: true, message: "No se pudo conectar con el servidor. Reintenta sin cambiar el archivo." }); }
  }

  async function download(attachment: SupportIncidentAttachmentDto) {
    setDownloadingId(attachment.id); setState({ busy: false });
    try {
      const response = await fetch(attachment.downloadUrl, { method: "POST", headers: { "X-CSRF-Token": await fetchCsrfToken() } });
      if (!response.ok) { const result = await response.json().catch(() => null) as { message?: string } | null; setState({ busy: false, error: true, message: result?.message ?? "No se pudo descargar el archivo." }); return; }
      const blob = await response.blob(); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = attachment.originalFileName; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch { setState({ busy: false, error: true, message: "No se pudo conectar con el servidor." }); } finally { setDownloadingId(null); }
  }

  return <div className="panel stack"><h2>Adjuntos</h2>{attachments.length === 0 ? <p className="muted">Todavía no hay adjuntos.</p> : <ul className="stack">{attachments.map((attachment) => <li key={attachment.id} className="compact-stack"><div><strong>{attachment.originalFileName}</strong> · {attachment.mediaType === "application/pdf" ? "PDF" : "JPG"} · {formatBytes(attachment.sizeBytes)}</div><span className="cell-detail">{attachment.uploadedBy.displayName} · <time dateTime={attachment.uploadedAt}>{new Date(attachment.uploadedAt).toLocaleString("es-ES")}</time>{attachment.sourceIncident.id !== incidentId ? ` · Origen: ${attachment.sourceIncident.number}` : ""}</span>{canDownload ? <div><button type="button" className="button button-secondary" disabled={downloadingId !== null} onClick={() => void download(attachment)}>{downloadingId === attachment.id ? "Descargando…" : `Descargar ${attachment.originalFileName}`}</button></div> : null}</li>)}</ul>}
    {nextCursor ? <div><a className="button button-secondary" href={`/app/support/incidents/${incidentId}?attachmentCursor=${encodeURIComponent(nextCursor)}`}>Ver adjuntos anteriores</a></div> : null}
    {canUpload ? <form className="form-grid" onSubmit={upload}><fieldset disabled={state.busy}><legend>Adjuntar archivo</legend><label>Archivo<input name="file" type="file" required accept="image/jpeg,application/pdf,.jpg,.jpeg,.pdf" /></label><p className="muted">JPG o PDF, máximo 16 MiB. El archivo será analizado y no podrá eliminarse.</p></fieldset><div className="form-actions"><button className="button" disabled={state.busy}>{state.busy ? "Analizando…" : "Adjuntar archivo"}</button></div></form> : null}
    {state.message ? <p role={state.error ? "alert" : "status"} className={state.error ? "message error" : "message"}>{state.message}</p> : null}</div>;
}

function formatBytes(value: number): string { if (value < 1024) return `${value} B`; if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`; return `${(value / (1024 * 1024)).toFixed(1)} MiB`; }
