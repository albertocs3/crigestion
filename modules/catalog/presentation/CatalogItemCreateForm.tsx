"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import type { CatalogCategoryListItem } from "@/modules/catalog/application/categories";
import type { CatalogTaxRateListItem } from "@/modules/catalog/application/taxRates";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export function CatalogItemCreateForm({
  categories,
  taxRates
}: {
  categories: CatalogCategoryListItem[];
  taxRates: CatalogTaxRateListItem[];
}) {
  const router = useRouter();
  const [state, setState] = useState<SubmissionState>({ status: "idle" });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ status: "submitting" });

    const form = event.currentTarget;
    const csrfToken = await fetchCsrfToken();
    const response = await fetch("/api/catalog/items", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
        "X-CSRF-Token": csrfToken
      },
      body: JSON.stringify(catalogItemPayload(new FormData(form)))
    });

    if (response.ok) {
      form.reset();
      setState({ status: "success", message: "Elemento creado." });
      router.refresh();
      return;
    }

    const body = (await response.json().catch(() => null)) as
      | { message?: string; code?: string }
      | null;

    setState({
      status: "error",
      message: body?.message ?? body?.code ?? "No se pudo crear el elemento."
    });
  }

  return (
    <form className="form-grid" onSubmit={handleSubmit}>
      <CatalogItemFields categories={categories} taxRates={taxRates} />
      <div className="form-actions">
        <button className="button" disabled={state.status === "submitting"} type="submit">
          {state.status === "submitting" ? "Creando..." : "Crear elemento"}
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

export function CatalogItemFields({
  defaults,
  categories,
  taxRates
}: {
  categories: CatalogCategoryListItem[];
  taxRates: CatalogTaxRateListItem[];
  defaults?: {
    category: {
      id: string;
    } | null;
    kind: "PRODUCT" | "SERVICE" | "SOFTWARE" | "LICENSE";
    name: string;
    description: string | null;
    unitName: string;
    salePrice: string;
    costPrice: string;
    tax: {
      id: string;
    };
    stock: {
      tracked: boolean;
      current: string;
      minimum: string;
    };
  };
}) {
  const defaultTaxRateId =
    defaults?.tax.id ?? taxRates.find((taxRate) => taxRate.isDefault)?.id ?? taxRates[0]?.id;

  return (
    <fieldset>
      <legend>{defaults ? "Editar elemento" : "Nuevo articulo o servicio"}</legend>
      <div className="form-three-columns">
        <label>
          Categoria
          <select name="categoryId" defaultValue={defaults?.category?.id ?? ""}>
            <option value="">Sin categoria</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Tipo
          <select name="kind" required defaultValue={defaults?.kind ?? "SERVICE"}>
            <option value="PRODUCT">Producto</option>
            <option value="SERVICE">Servicio</option>
            <option value="SOFTWARE">Software</option>
            <option value="LICENSE">Licencia</option>
          </select>
        </label>
        <label>
          Nombre
          <input
            name="name"
            required
            minLength={2}
            maxLength={200}
            defaultValue={defaults?.name ?? ""}
          />
        </label>
        <label>
          Unidad
          <input
            name="unitName"
            required
            maxLength={40}
            defaultValue={defaults?.unitName ?? "Unidades"}
          />
        </label>
      </div>
      <label>
        Descripcion comercial
        <textarea
          name="description"
          maxLength={1000}
          rows={3}
          defaultValue={defaults?.description ?? ""}
        />
      </label>
      <div className="form-three-columns">
        <label>
          Precio venta sin IVA
          <input
            name="salePrice"
            required
            inputMode="decimal"
            pattern="[0-9]+([.][0-9]{1,2})?"
            defaultValue={defaults?.salePrice ?? "0.00"}
          />
        </label>
        <label>
          Ultimo coste sin IVA
          <input
            name="costPrice"
            required
            inputMode="decimal"
            pattern="[0-9]+([.][0-9]{1,2})?"
            defaultValue={defaults?.costPrice ?? "0.00"}
          />
        </label>
        <label>
          IVA
          <select
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
      <div className="form-three-columns">
        <label className="checkbox-label">
          <input
            name="stockTracked"
            type="checkbox"
            defaultChecked={defaults?.stock.tracked ?? false}
          />
          <span>
            <strong>Control de stock</strong>
            <small>Solo para productos fisicos.</small>
          </span>
        </label>
        <label>
          Stock actual
          <input
            name="stockCurrent"
            inputMode="decimal"
            pattern="-?[0-9]+([.][0-9]{1,3})?"
            defaultValue={defaults?.stock.current ?? "0.000"}
          />
        </label>
        <label>
          Stock minimo
          <input
            name="stockMinimum"
            inputMode="decimal"
            pattern="[0-9]+([.][0-9]{1,3})?"
            defaultValue={defaults?.stock.minimum ?? "0.000"}
          />
        </label>
      </div>
    </fieldset>
  );
}

export function catalogItemPayload(formData: FormData) {
  return {
    kind: String(formData.get("kind") ?? "SERVICE"),
    categoryId: nullableString(formData.get("categoryId")),
    name: String(formData.get("name") ?? ""),
    description: nullableString(formData.get("description")),
    unitName: String(formData.get("unitName") ?? "Unidades"),
    salePrice: String(formData.get("salePrice") ?? "0.00"),
    costPrice: String(formData.get("costPrice") ?? "0.00"),
    taxRateId: String(formData.get("taxRateId") ?? ""),
    stockTracked: formData.get("stockTracked") === "on",
    stockCurrent: String(formData.get("stockCurrent") ?? "0.000"),
    stockMinimum: String(formData.get("stockMinimum") ?? "0.000")
  };
}

function nullableString(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}
