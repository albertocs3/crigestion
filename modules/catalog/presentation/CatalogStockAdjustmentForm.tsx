"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import type { CatalogItemListItem } from "@/modules/catalog/application/items";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export function CatalogStockAdjustmentForm({
  item
}: {
  item: CatalogItemListItem;
}) {
  const router = useRouter();
  const [state, setState] = useState<SubmissionState>({ status: "idle" });

  if (item.kind !== "PRODUCT" || !item.stock.tracked) {
    return null;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ status: "submitting" });

    const form = event.currentTarget;

    try {
      const csrfToken = await fetchCsrfToken();
      const response = await fetch(`/api/catalog/items/${item.id}/stock-movements`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken
        },
        body: JSON.stringify(stockAdjustmentPayload(new FormData(form)))
      });

      if (response.ok) {
        form.reset();
        setState({ status: "success", message: "Stock ajustado." });
        router.refresh();
        return;
      }

      const body = (await response.json().catch(() => null)) as
        | { message?: string; code?: string }
        | null;

      setState({
        status: "error",
        message: body?.message ?? body?.code ?? "No se pudo ajustar el stock."
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
      <summary className="button button-secondary button-small">Ajustar stock</summary>
      <form className="table-form" onSubmit={handleSubmit}>
        <fieldset>
          <legend>Ajuste de stock</legend>
          <div className="form-two-columns">
            <label>
              Cantidad
              <input
                name="quantity"
                required
                inputMode="decimal"
                pattern="-?[0-9]+([.][0-9]{1,3})?"
                placeholder="1.000 o -1.000"
              />
            </label>
            <label>
              Motivo
              <input
                name="reason"
                required
                minLength={3}
                maxLength={500}
                placeholder="Regularizacion de inventario"
              />
            </label>
          </div>
        </fieldset>
        <div className="form-actions">
          <button
            className="button button-small"
            disabled={state.status === "submitting"}
            type="submit"
          >
            {state.status === "submitting" ? "Ajustando..." : "Registrar ajuste"}
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

function stockAdjustmentPayload(formData: FormData) {
  return {
    quantity: String(formData.get("quantity") ?? ""),
    reason: String(formData.get("reason") ?? "")
  };
}
