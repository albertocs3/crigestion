"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import type { CatalogCategoryListItem } from "@/modules/catalog/application/categories";
import type { CatalogItemListItem } from "@/modules/catalog/application/items";
import type { CatalogTaxRateListItem } from "@/modules/catalog/application/taxRates";
import {
  CatalogItemFields,
  catalogItemPayload
} from "@/modules/catalog/presentation/CatalogItemCreateForm";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export function CatalogItemEditForm({
  item,
  categories,
  taxRates
}: {
  item: CatalogItemListItem;
  categories: CatalogCategoryListItem[];
  taxRates: CatalogTaxRateListItem[];
}) {
  const router = useRouter();
  const [state, setState] = useState<SubmissionState>({ status: "idle" });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ status: "submitting" });

    const form = event.currentTarget;

    try {
      const csrfToken = await fetchCsrfToken();
      const response = await fetch(`/api/catalog/items/${item.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
          "X-CSRF-Token": csrfToken
        },
        body: JSON.stringify({
          action: "update",
          item: catalogItemPayload(new FormData(form))
        })
      });

      if (response.ok) {
        setState({ status: "success", message: "Elemento actualizado." });
        router.refresh();
        return;
      }

      const body = (await response.json().catch(() => null)) as
        | { message?: string; code?: string }
        | null;

      setState({
        status: "error",
        message: body?.message ?? body?.code ?? "No se pudo actualizar el elemento."
      });
    } catch {
      setState({
        status: "error",
        message: "No se pudo conectar con el servidor."
      });
    }
  }

  return (
    <details className="details-panel">
      <summary className="button button-secondary button-small">Editar</summary>
      <form className="table-form" onSubmit={handleSubmit}>
        <CatalogItemFields
          categories={categories}
          defaults={item}
          taxRates={taxRates}
        />
        <div className="form-actions">
          <button
            className="button button-small"
            disabled={state.status === "submitting"}
            type="submit"
          >
            {state.status === "submitting" ? "Guardando..." : "Guardar"}
          </button>
        </div>
        {state.status === "success" || state.status === "error" ? (
          <p className={state.status === "error" ? "message error" : "message"}>
            {state.message}
          </p>
        ) : null}
      </form>
    </details>
  );
}
