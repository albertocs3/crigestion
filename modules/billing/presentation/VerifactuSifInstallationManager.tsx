"use client";

import Link from "next/link";
import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { VerifactuSifInstallationManagement } from "../application/verifactuSifInstallations";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type Management = NonNullable<VerifactuSifInstallationManagement>;
type SubmissionState = { status: "idle" | "submitting" | "success" | "error"; message?: string };

export function VerifactuSifInstallationManager({ management }: { management: Management }) {
  const activeTest = management.installations.find((item) => item.environment === "TEST" && item.status === "ACTIVE");
  return <div className="stack">
    {activeTest ? <div className="message"><strong>La instalación TEST activa ya está creada.</strong> Para preservar su cadena fiscal no se reemplaza ni se edita desde esta pantalla.</div> : <CreateInstallationForm management={management} />}
    <section className="stack" aria-labelledby="sif-installations-heading">
      <div className="split-header"><div><h2 id="sif-installations-heading">Instalaciones configuradas</h2><p className="muted">La identidad técnica queda fijada al iniciar la cadena VeriFactu.</p></div>{activeTest ? <Link className="button" href="/app/verifactu/credentials">Importar certificado</Link> : null}</div>
      {management.installations.length === 0 ? <p className="message">Todavía no hay instalaciones SIF.</p> : management.installations.map((installation) => <article className="credential-installation stack" key={installation.id}>
        <div className="split-header"><div><h3>{installation.installationCode}</h3><p className="muted">{installation.environment} · {installation.status}</p></div><span className="status"><span aria-hidden="true" className={`status-dot status-dot-${installation.credentialAlias ? "active" : "inactive"}`} />{installation.credentialAlias ?? "Sin credencial activa"}</span></div>
        <div className="data-grid"><Data label="Productor" value={`${installation.producerName} · ${installation.producerTaxId}`} /><Data label="Sistema" value={`${installation.systemName} · ${installation.systemId}`} /><Data label="Versión" value={installation.systemVersion} /><Data label="N.º instalación" value={installation.installationNumber} /><Data label="Contrato" value={`${installation.contractVersion} · ${installation.schemaVersion}`} /><Data label="Activada" value={new Date(installation.activatedAt).toLocaleString("es-ES")} /></div>
      </article>)}
    </section>
  </div>;
}

function CreateInstallationForm({ management }: { management: Management }) {
  const router = useRouter();
  const idempotencyRef = useRef<{ hash: string; key: string } | null>(null);
  const [state, setState] = useState<SubmissionState>({ status: "idle" });
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const body = {
      installationCode: String(data.get("installationCode") ?? ""),
      producerTaxId: String(data.get("producerTaxId") ?? ""),
      producerName: String(data.get("producerName") ?? ""),
      systemName: String(data.get("systemName") ?? ""),
      systemId: String(data.get("systemId") ?? ""),
      systemVersion: String(data.get("systemVersion") ?? ""),
      installationNumber: String(data.get("installationNumber") ?? "")
    };
    if (!window.confirm("Se creará la instalación SIF TEST y su identidad quedará ligada a la cadena fiscal. ¿Continuar?")) return;
    setState({ status: "submitting" });
    try {
      const serialized = JSON.stringify(body);
      const hash = await sha256Hex(serialized);
      if (idempotencyRef.current?.hash !== hash) idempotencyRef.current = { hash, key: crypto.randomUUID() };
      const response = await fetch("/api/platform/verifactu/sif-installations", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyRef.current.key, "X-CSRF-Token": await fetchCsrfToken() },
        body: serialized
      });
      if (response.status < 500) idempotencyRef.current = null;
      const responseBody = await response.json().catch(() => null) as { code?: string; message?: string } | null;
      if (!response.ok) return setState({ status: "error", message: responseBody?.message ?? responseBody?.code ?? "No se pudo crear la instalación SIF." });
      setState({ status: "success", message: "Instalación TEST creada. Ya puedes importar el certificado." });
      router.refresh();
    } catch {
      setState({ status: "error", message: "Resultado incierto. Reintenta sin modificar los datos para reutilizar la clave idempotente." });
    }
  }
  return <form className="form-grid" onSubmit={submit}>
    <fieldset disabled={state.status === "submitting"}>
      <legend>Crear instalación SIF TEST</legend>
      <p className="muted">El productor identifica a quien desarrolla el software; no tiene por qué coincidir con la empresa usuaria. Entorno, contrato, esquema y manifiesto se fijan en servidor.</p>
      <div className="form-two-columns">
        <label>Código de instalación<input name="installationCode" required maxLength={80} defaultValue="TEST-01" pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,79}" /><span className="cell-detail">Identificador interno, por ejemplo TEST-01.</span></label>
        <label>Número de instalación<input name="installationNumber" required maxLength={100} defaultValue="TEST-01" /></label>
        <label>Nombre del productor<input name="producerName" required maxLength={120} /></label>
        <label>NIF del productor<input name="producerTaxId" required maxLength={32} inputMode="text" /></label>
        <label>Nombre del sistema<input name="systemName" required maxLength={30} defaultValue="CriGestion" /></label>
        <label>Identificador del sistema<input name="systemId" required minLength={2} maxLength={2} pattern="[A-Za-z0-9]{2}" defaultValue="CG" /><span className="cell-detail">Exactamente 2 caracteres.</span></label>
        <label>Versión del sistema<input name="systemVersion" required maxLength={40} defaultValue={management.suggestedSystemVersion} /></label>
      </div>
      <div className="message"><strong>Valores técnicos:</strong> TEST · VF_V1 · tikeV1.0 · AEAT_VERIFACTU_ARTIFACTS_V1</div>
      <div className="form-actions"><button className="button" type="submit" disabled={state.status === "submitting"}>{state.status === "submitting" ? "Creando…" : "Crear instalación TEST"}</button></div>
      {state.status === "success" || state.status === "error" ? <p className={state.status === "error" ? "message error" : "message"} role={state.status === "error" ? "alert" : "status"}>{state.message}</p> : null}
    </fieldset>
  </form>;
}

function Data({ label, value }: { label: string; value: string }) { return <div><span className="data-label">{label}</span><strong>{value}</strong></div>; }
async function sha256Hex(value: string): Promise<string> { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)); return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""); }
