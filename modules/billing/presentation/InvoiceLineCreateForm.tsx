"use client";

import { FormEvent, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { CatalogItemListItem } from "@/modules/catalog/application/items";
import type { CatalogTaxRateListItem } from "@/modules/catalog/application/taxRates";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export function InvoiceLineCreateForm({
  invoiceId,
  items,
  taxRates
}: {
  invoiceId: string;
  items: CatalogItemListItem[];
  taxRates: CatalogTaxRateListItem[];
}) {
  const router = useRouter();
  const [state, setState] = useState<SubmissionState>({ status: "idle" });
  const [selectedItemId, setSelectedItemId] = useState("");
  const selectedItem = useMemo(
    () => items.find((item) => item.id === selectedItemId) ?? null,
    [items, selectedItemId]
  );
  const defaultTaxRateId =
    selectedItem?.tax.id ??
    taxRates.find((taxRate) => taxRate.isDefault)?.id ??
    taxRates[0]?.id ??
    "";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ status: "submitting" });

    const form = event.currentTarget;
    const csrfToken = await fetchCsrfToken();
    const response = await fetch(`/api/invoices/${invoiceId}/lines`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken
      },
      body: JSON.stringify(invoiceLinePayload(new FormData(form)))
    });

    if (response.ok) {
      form.reset();
      setSelectedItemId("");
      setState({ status: "success", message: "Linea agregada." });
      router.refresh();
      return;
    }

    const body = (await response.json().catch(() => null)) as
      | { message?: string; code?: string }
      | null;

    setState({
      status: "error",
      message: body?.message ?? body?.code ?? "No se pudo agregar la linea."
    });
  }

  return (
    <form className="form-grid" onSubmit={handleSubmit}>
      <fieldset>
        <legend>Nueva linea</legend>
        <div className="form-two-columns">
          <label>
            Catalogo
            <select
              name="catalogItemId"
              value={selectedItemId}
              onChange={(event) => setSelectedItemId(event.currentTarget.value)}
            >
              <option value="">Linea manual</option>
              {items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.code} - {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            IVA
            <select
              key={defaultTaxRateId}
              name="taxRateId"
              required
              defaultValue={defaultTaxRateId}
              disabled={taxRates.length === 0}
            >
              {taxRates.map((taxRate) => (
                <option key={taxRate.id} value={taxRate.id}>
                  {taxRate.name} ({taxRate.rate}%)
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          Descripcion
          <textarea
            key={selectedItem?.id ?? "manual-description"}
            name="description"
            required
            maxLength={500}
            rows={3}
            defaultValue={selectedItem?.name ?? ""}
          />
        </label>
        <div className="form-four-columns">
          <label>
            Cantidad
            <input
              name="quantity"
              required
              inputMode="decimal"
              pattern="-?[0-9]+([.][0-9]{1,3})?"
              defaultValue="1.000"
            />
          </label>
          <label>
            Precio unitario sin IVA
            <input
              key={selectedItem?.id ?? "manual-price"}
              name="unitPrice"
              required
              inputMode="decimal"
              pattern="[0-9]+([.][0-9]{1,2})?"
              defaultValue={selectedItem?.salePrice ?? "0.00"}
            />
          </label>
          <label>
            Descuento %
            <input
              name="discountPercent"
              required
              inputMode="decimal"
              pattern="[0-9]+([.][0-9]{1,2})?"
              defaultValue="0.00"
            />
          </label>
          <label>
            Descuento importe
            <input
              name="discountAmount"
              required
              inputMode="decimal"
              pattern="[0-9]+([.][0-9]{1,2})?"
              defaultValue="0.00"
            />
          </label>
        </div>
      </fieldset>
      <div className="form-actions">
        <button
          className="button"
          disabled={state.status === "submitting" || taxRates.length === 0}
          type="submit"
        >
          {state.status === "submitting" ? "Agregando..." : "Agregar linea"}
        </button>
        {state.status === "success" || state.status === "error" ? (
          <p className={state.status === "error" ? "message error" : "message"}>
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}

function invoiceLinePayload(formData: FormData) {
  return {
    catalogItemId: optionalString(formData.get("catalogItemId")),
    description: String(formData.get("description") ?? ""),
    quantity: String(formData.get("quantity") ?? "1.000"),
    unitPrice: String(formData.get("unitPrice") ?? "0.00"),
    discountPercent: String(formData.get("discountPercent") ?? "0.00"),
    discountAmount: String(formData.get("discountAmount") ?? "0.00"),
    taxRateId: String(formData.get("taxRateId") ?? "")
  };
}

function optionalString(value: FormDataEntryValue | null): string | undefined {
  const text = String(value ?? "").trim();
  return text ? text : undefined;
}
