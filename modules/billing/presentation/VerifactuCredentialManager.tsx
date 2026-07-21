"use client";

import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { VerifactuCredentialManagement } from "../application/verifactuCredentials";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";
import { createIdempotencyKey, fingerprintBytes, fingerprintText } from "./idempotencyFingerprint";

type SubmissionState = { status: "idle" | "submitting" | "success" | "error"; message?: string };

export function VerifactuCredentialManager({ management }: { management: VerifactuCredentialManagement }) {
  const testInstallations = management.installations.filter((item) => item.environment === "TEST" && item.status === "ACTIVE");
  const productionInstallations = management.installations.filter((item) => item.environment === "PRODUCTION" && item.status === "ACTIVE");
  return (
    <div className="stack">
      <CredentialImportForm testInstallations={testInstallations} />
      <section className="stack" aria-labelledby="verifactu-installations-heading">
        <div><h2 id="verifactu-installations-heading">Instalaciones</h2><p className="muted">La credencial operativa solo cambia después de superar la consulta AEAT TEST.</p></div>
        {management.installations.length === 0 ? <p className="message">No hay instalaciones SIF configuradas.</p> : management.installations.map((installation) => (
          <article className="credential-installation" key={installation.id}>
            <div className="split-header">
              <div><h3>{installation.installationCode}</h3><p className="muted">{installation.environment} · {installation.status}</p></div>
              <span className="status"><span aria-hidden="true" className={`status-dot status-dot-${installation.credential ? "active" : "inactive"}`} />{installation.credential ? installation.credential.alias : "Sin credencial activa"}</span>
            </div>
          </article>
        ))}
      </section>
      <section className="stack" aria-labelledby="verifactu-credentials-heading">
        <div><h2 id="verifactu-credentials-heading">Credenciales y versiones</h2><p className="muted">Las versiones STAGED siguen visibles aunque todavía no estén asignadas a una instalación.</p></div>
        {management.credentials.length === 0 ? <p className="message">No hay certificados importados.</p> : management.credentials.map((credential) => (
          <article className="credential-installation" key={`${credential.alias}-${credential.versions[0]?.id ?? "empty"}`}>
            <div className="split-header">
              <div><h3>{credential.alias}</h3><p className="muted">{credential.assignments.length > 0 ? credential.assignments.map((item) => `${item.installationCode} · ${item.environment}`).join("; ") : "Todavía sin asignar"}</p></div>
              <CredentialStatus status={credential.status} />
            </div>
            {credential.versions.length > 0 ? (
              <div className="table-wrap"><table aria-label={`Versiones de la credencial ${credential.alias}`}><thead><tr><th>Versión</th><th>Estado</th><th>Endpoint</th><th>Vigencia</th><th>Última prueba</th><th>Acción</th></tr></thead><tbody>
                {credential.versions.map((version) => (
                  <tr key={version.id}>
                    <td>v{version.version}</td><td><CredentialStatus status={version.status} /></td><td>{version.endpointKind}</td>
                    <td><time dateTime={version.validFrom}>{formatDate(version.validFrom)}</time><span className="cell-detail">hasta {formatDate(version.validUntil)}</span></td>
                    <td>{version.latestTest ? <><strong>{version.latestTest.outcome}</strong><span className="cell-detail">{version.latestTest.stableCode ?? formatDate(version.latestTest.startedAt)}</span></> : "Sin prueba"}</td>
                    <td>{version.status === "STAGED" ? <CredentialActivationForm versionId={version.id} testInstallations={testInstallations} productionInstallations={productionInstallations} allowProduction={version.allowProduction} latestTest={version.latestTest} /> : <span className="muted">Sin acción</span>}</td>
                  </tr>
                ))}
              </tbody></table></div>
            ) : <p className="message">Esta credencial no tiene versiones.</p>}
          </article>
        ))}
      </section>
    </div>
  );
}

function CredentialImportForm({ testInstallations }: { testInstallations: VerifactuCredentialManagement["installations"] }) {
  const router = useRouter();
  const idempotencyRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const [state, setState] = useState<SubmissionState>({ status: "idle" });
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const file = data.get("certificate");
    if (!(file instanceof File) || file.size < 1 || file.size > 512 * 1024) return setState({ status: "error", message: "Selecciona un PFX de hasta 512 KiB." });
    setState({ status: "submitting" });
    let pfxBytes: Uint8Array | null = null;
    try {
      pfxBytes = new Uint8Array(await file.arrayBuffer());
      const fields = {
        sifInstallationId: String(data.get("sifInstallationId") ?? ""),
        alias: String(data.get("alias") ?? ""),
        passphrase: String(data.get("passphrase") ?? ""),
        endpointKind: String(data.get("endpointKind") ?? "STANDARD"),
        allowProduction: data.get("allowProduction") === "on"
      };
      const csrfToken = await fetchCsrfToken();
      const fingerprint = fingerprintText(JSON.stringify({
        ...fields,
        passphraseFingerprint: fingerprintText(fields.passphrase),
        pfxFingerprint: fingerprintBytes(pfxBytes)
      }));
      const requestBody = new FormData();
      requestBody.set("sifInstallationId", fields.sifInstallationId);
      requestBody.set("alias", fields.alias);
      requestBody.set("passphrase", fields.passphrase);
      requestBody.set("endpointKind", fields.endpointKind);
      requestBody.set("allowProduction", String(fields.allowProduction));
      requestBody.set("certificate", file, file.name);
      if (idempotencyRef.current?.fingerprint !== fingerprint) idempotencyRef.current = { fingerprint, key: createIdempotencyKey() };
      const response = await fetch("/api/platform/verifactu/credentials", { method: "POST", headers: { "Idempotency-Key": idempotencyRef.current.key, "X-CSRF-Token": csrfToken }, body: requestBody });
      if (response.status < 500) idempotencyRef.current = null;
      const body = await response.json().catch(() => null) as { message?: string; code?: string } | null;
      if (!response.ok) return setState({ status: "error", message: body?.message ?? body?.code ?? "No se pudo importar el certificado." });
      form.reset();
      setState({ status: "success", message: "Certificado importado como versión STAGED." });
      router.refresh();
    } catch { setState({ status: "error", message: "No se pudo importar el certificado. Puedes reintentar con el mismo archivo." }); }
    finally {
      pfxBytes?.fill(0);
      const certificate = form.elements.namedItem("certificate");
      const passphrase = form.elements.namedItem("passphrase");
      if (certificate instanceof HTMLInputElement) certificate.value = "";
      if (passphrase instanceof HTMLInputElement) passphrase.value = "";
    }
  }
  return (
    <form className="form-grid credential-import" onSubmit={handleSubmit}>
      <fieldset disabled={state.status === "submitting" || testInstallations.length === 0}>
        <legend>Importar nueva versión</legend>
        <div className="form-two-columns">
          <label>Instalación TEST<select name="sifInstallationId" required>{testInstallations.length === 0 ? <option value="">No hay instalaciones TEST activas</option> : testInstallations.map((item) => <option key={item.id} value={item.id}>{item.installationCode}</option>)}</select></label>
          <label>Alias<input name="alias" required maxLength={120} placeholder="Certificado AEAT TEST" /></label>
          <label>Archivo PFX<input name="certificate" type="file" required accept=".p12,.pfx,application/x-pkcs12" /><span className="cell-detail">El archivo se envía directamente y nunca vuelve a mostrarse.</span></label>
          <label>Contraseña del PFX<input name="passphrase" type="password" maxLength={4096} autoComplete="off" /></label>
          <label>Tipo de endpoint<select name="endpointKind"><option value="STANDARD">STANDARD</option><option value="SEAL">SEAL</option></select></label>
          <label className="checkbox-label"><input name="allowProduction" type="checkbox" />Permitir asociación posterior a producción</label>
        </div>
        <div className="form-actions"><button className="button" type="submit" disabled={state.status === "submitting" || testInstallations.length === 0}>{state.status === "submitting" ? "Cifrando e importando..." : "Importar certificado"}</button></div>
        <SubmissionMessage state={state} />
      </fieldset>
    </form>
  );
}

function CredentialActivationForm({ versionId, testInstallations, productionInstallations, allowProduction, latestTest }: { versionId: string; testInstallations: VerifactuCredentialManagement["installations"]; productionInstallations: VerifactuCredentialManagement["installations"]; allowProduction: boolean; latestTest: VerifactuCredentialManagement["credentials"][number]["versions"][number]["latestTest"] }) {
  const router = useRouter();
  const idempotencyRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const [state, setState] = useState<SubmissionState>({ status: "idle" });
  const [installationId, setInstallationId] = useState(testInstallations[0]?.id ?? "");
  const installation = testInstallations.find((item) => item.id === installationId);
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const target = String(data.get("targetProductionSifInstallationId") ?? "");
    const productionTarget = productionInstallations.find((item) => item.id === target);
    if (!window.confirm("Se consultará AEAT TEST y, si la prueba es válida, se rotará la credencial activa. ¿Continuar?")) return;
    if (productionTarget && !window.confirm(`Confirmación de PRODUCCIÓN: la credencial se asociará inmediatamente a ${productionTarget.installationCode}. ¿Confirmas este cambio productivo?`)) return;
    setState({ status: "submitting" });
    try {
      const csrfToken = await fetchCsrfToken();
      if (!installation) return setState({ status: "error", message: "Selecciona una instalación TEST activa." });
      const requestBody = JSON.stringify({ sifInstallationId: installation.id, fiscalRecordId: String(data.get("fiscalRecordId") ?? ""), ...(target ? { targetProductionSifInstallationId: target } : {}) });
      const fingerprint = fingerprintText(requestBody);
      if (idempotencyRef.current?.fingerprint !== fingerprint) idempotencyRef.current = { fingerprint, key: createIdempotencyKey() };
      const response = await fetch(`/api/platform/verifactu/credential-versions/${versionId}/activate`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyRef.current.key, "X-CSRF-Token": csrfToken }, body: requestBody });
      if (response.status < 500 || response.status === 502) idempotencyRef.current = null;
      const body = await response.json().catch(() => null) as { message?: string; code?: string } | null;
      if (!response.ok) return setState({ status: "error", message: body?.message ?? body?.code ?? "No se pudo probar y activar la versión." });
      setState({ status: "success", message: "Prueba AEAT superada y versión activada." });
      router.refresh();
    } catch { setState({ status: "error", message: "No se pudo probar y activar la versión." }); }
  }
  return (
    <form className="table-form" onSubmit={handleSubmit}>
      <label>Instalación TEST<select value={installationId} onChange={(event) => setInstallationId(event.target.value)} disabled={state.status === "submitting" || testInstallations.length === 0}>{testInstallations.length === 0 ? <option value="">Sin instalación TEST activa</option> : testInstallations.map((item) => <option key={item.id} value={item.id}>{item.installationCode}</option>)}</select></label>
      <label>Registro para consulta<select name="fiscalRecordId" required disabled={state.status === "submitting" || !installation || installation.fiscalRecords.length === 0}>{!installation || installation.fiscalRecords.length === 0 ? <option value="">Sin registros fiscales</option> : installation.fiscalRecords.map((record) => <option key={record.id} value={record.id}>{record.invoiceNumber} · {formatShortDate(record.issueDate)}</option>)}</select></label>
      {allowProduction && productionInstallations.length > 0 ? <label>Asociar también a<select name="targetProductionSifInstallationId" disabled={state.status === "submitting"}><option value="">Solo TEST</option>{productionInstallations.map((item) => <option key={item.id} value={item.id}>{item.installationCode} · PRODUCTION</option>)}</select></label> : null}
      <button className="button button-small" type="submit" disabled={state.status === "submitting" || !installation || installation.fiscalRecords.length === 0}>{state.status === "submitting" ? "Probando..." : latestTest?.outcome === "FAILED" || state.status === "error" ? "Reintentar prueba" : "Probar y activar"}</button>
      {latestTest?.outcome === "FAILED" ? <p className="cell-detail">Se reutilizará el mismo registro fiscal; no se emitirá otra factura.</p> : null}
      <SubmissionMessage state={state} />
    </form>
  );
}

function CredentialStatus({ status }: { status: string }) { return <span className="status"><span aria-hidden="true" className={`status-dot status-dot-${status.toLowerCase()}`} />{status}</span>; }
function SubmissionMessage({ state }: { state: SubmissionState }) { if (state.status !== "success" && state.status !== "error") return null; return <p aria-live="polite" role={state.status === "error" ? "alert" : "status"} className={state.status === "error" ? "message error" : "message"}>{state.message}</p>; }
function formatDate(value: string): string { return new Date(value).toLocaleString("es-ES"); }
function formatShortDate(value: string): string { return new Date(value).toLocaleDateString("es-ES"); }
