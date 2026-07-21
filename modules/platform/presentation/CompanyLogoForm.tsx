"use client";

import Image from "next/image";
import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { CompanyLogoDto } from "@/modules/platform/application/companyLogoAttachments";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export function CompanyLogoForm({ logo }: { logo: CompanyLogoDto | null }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const requestIdentityRef = useRef<{ signature: string; key: string } | null>(null);
  const [state, setState] = useState<SubmissionState>({ status: "idle" });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ status: "submitting" });
    const formData = new FormData(event.currentTarget);
    formData.set("expectedLogoId", logo?.id ?? "");
    const selectedFile = formData.get("logo");
    if (!(selectedFile instanceof File)) {
      setState({ status: "error", message: "Selecciona un archivo PNG o JPG." });
      return;
    }
    const signature = [
      logo?.id ?? "",
      selectedFile.name,
      selectedFile.type,
      selectedFile.size,
      selectedFile.lastModified
    ].join(":");
    if (requestIdentityRef.current?.signature !== signature) {
      requestIdentityRef.current = { signature, key: crypto.randomUUID() };
    }

    try {
      const csrfToken = await fetchCsrfToken();
      const response = await fetch("/api/platform/configuration/company/logo", {
        method: "PUT",
        headers: {
          "Idempotency-Key": requestIdentityRef.current.key,
          "X-CSRF-Token": csrfToken
        },
        body: formData
      });
      const body = (await response.json().catch(() => null)) as
        | { code?: string; message?: string }
        | null;

      if (!response.ok) {
        setState({
          status: "error",
          message: body?.message ?? body?.code ?? "No se pudo guardar el logotipo."
        });
        return;
      }

      formRef.current?.reset();
      requestIdentityRef.current = null;
      setState({
        status: "success",
        message: logo ? "Logotipo reemplazado." : "Logotipo guardado."
      });
      router.refresh();
    } catch {
      setState({ status: "error", message: "No se pudo guardar el logotipo." });
    }
  }

  return (
    <form className="form-grid" ref={formRef} onSubmit={handleSubmit}>
      <fieldset>
        <legend>Logotipo empresarial</legend>
        {logo ? (
          <div className="stack-sm">
            <Image
              alt="Logotipo empresarial actual"
              height={120}
              key={logo.id}
              src={`${logo.downloadUrl}?version=${encodeURIComponent(logo.id)}`}
              unoptimized
              width={240}
            />
            <p className="muted">
              {logo.contentType === "image/png" ? "PNG" : "JPG"} · {formatBytes(logo.sizeBytes)}
            </p>
          </div>
        ) : (
          <p className="muted">Todavia no hay un logotipo configurado.</p>
        )}
        <label>
          {logo ? "Nuevo logotipo" : "Logotipo"}
          <input
            accept="image/png,image/jpeg,.png,.jpg"
            name="logo"
            required
            type="file"
          />
        </label>
        <p className="muted">
          PNG o JPG, una imagen estatica, hasta 5 MiB y 4096 × 4096 px. El archivo se
          valida, normaliza y analiza antes de publicarse.
        </p>
      </fieldset>

      <div className="form-actions">
        <button className="button" disabled={state.status === "submitting"} type="submit">
          {state.status === "submitting"
            ? "Analizando..."
            : logo
              ? "Reemplazar logotipo"
              : "Guardar logotipo"}
        </button>
        {state.status === "success" || state.status === "error" ? (
          <p
            aria-live="polite"
            className={state.status === "error" ? "message error" : "message"}
          >
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}

function formatBytes(value: number): string {
  return `${new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 }).format(value / 1024)} KiB`;
}
