"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import type { CustomerListItem } from "@/modules/customers/application/customers";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export function CustomerEditForm({ customer }: { customer: CustomerListItem }) {
  const router = useRouter();
  const [state, setState] = useState<SubmissionState>({ status: "idle" });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ status: "submitting" });

    const formData = new FormData(event.currentTarget);
    const sepaMandate = nullableSepaMandate(formData);
    const csrfToken = await fetchCsrfToken();
    const response = await fetch(`/api/customers/${customer.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken
      },
      body: JSON.stringify({
        action: "update",
        customer: {
          type: String(formData.get("type") ?? "COMPANY"),
          legalName: String(formData.get("legalName") ?? ""),
          tradeName: nullableString(formData.get("tradeName")),
          taxId: String(formData.get("taxId") ?? ""),
          fiscalTreatment: String(formData.get("fiscalTreatment") ?? "DOMESTIC"),
          email: nullableString(formData.get("email")),
          phone: nullableString(formData.get("phone")),
          fiscalAddressLine: String(formData.get("fiscalAddressLine") ?? ""),
          fiscalPostalCode: String(formData.get("fiscalPostalCode") ?? ""),
          fiscalCity: String(formData.get("fiscalCity") ?? ""),
          fiscalProvince: nullableString(formData.get("fiscalProvince")),
          fiscalCountry: String(formData.get("fiscalCountry") ?? "ES"),
          defaultPaymentMethod: String(formData.get("defaultPaymentMethod") ?? "BANK_TRANSFER"),
          paymentTermsType: String(formData.get("paymentTermsType") ?? "IMMEDIATE"),
          paymentDays: nullableNumber(formData.get("paymentDays")),
          paymentFixedDay: nullableNumber(formData.get("paymentFixedDay")),
          creditLimit: nullableString(formData.get("creditLimit")),
          bankIban: nullableString(formData.get("bankIban")),
          sepaMandate
        }
      })
    });

    if (response.ok) {
      setState({
        status: "success",
        message: "Cliente actualizado."
      });
      router.refresh();
      return;
    }

    const body = (await response.json().catch(() => null)) as
      | { message?: string; code?: string }
      | null;

    setState({
      status: "error",
      message: body?.message ?? body?.code ?? "No se pudo actualizar el cliente."
    });
  }

  return (
    <details className="details-panel">
      <summary className="button button-secondary button-small">Editar</summary>
      <form className="table-form" onSubmit={handleSubmit}>
        <label>
          Tipo
          <select name="type" required defaultValue={customer.type}>
            <option value="COMPANY">Empresa</option>
            <option value="SELF_EMPLOYED">Autonomo</option>
            <option value="INDIVIDUAL">Particular</option>
          </select>
        </label>
        <label>
          Razon social
          <input
            name="legalName"
            required
            minLength={2}
            maxLength={200}
            defaultValue={customer.legalName}
          />
        </label>
        <label>
          Nombre comercial
          <input
            name="tradeName"
            maxLength={160}
            defaultValue={customer.tradeName ?? ""}
          />
        </label>
        <label>
          NIF / VAT
          <input name="taxId" required minLength={3} maxLength={32} defaultValue={customer.taxId} />
        </label>
        <label>
          Fiscalidad
          <select name="fiscalTreatment" required defaultValue={customer.fiscalTreatment}>
            <option value="DOMESTIC">Nacional</option>
            <option value="EU">Intracomunitario</option>
            <option value="EXPORT">Exportacion</option>
            <option value="CANARY_CEUTA_MELILLA">Canarias, Ceuta o Melilla</option>
          </select>
        </label>
        <label>
          Email
          <input name="email" type="email" maxLength={254} defaultValue={customer.email ?? ""} />
        </label>
        <label>
          Telefono
          <input name="phone" maxLength={40} defaultValue={customer.phone ?? ""} />
        </label>
        <label>
          Direccion fiscal
          <input
            name="fiscalAddressLine"
            required
            minLength={3}
            maxLength={240}
            defaultValue={customer.fiscalAddress.line}
          />
        </label>
        <div className="form-three-columns">
          <label>
            CP
            <input
              name="fiscalPostalCode"
              required
              minLength={2}
              maxLength={20}
              defaultValue={customer.fiscalAddress.postalCode}
            />
          </label>
          <label>
            Localidad
            <input
              name="fiscalCity"
              required
              minLength={2}
              maxLength={120}
              defaultValue={customer.fiscalAddress.city}
            />
          </label>
          <label>
            Pais
            <input
              name="fiscalCountry"
              required
              minLength={2}
              maxLength={2}
              defaultValue={customer.fiscalAddress.country}
            />
          </label>
        </div>
        <label>
          Provincia
          <input
            name="fiscalProvince"
            maxLength={120}
            defaultValue={customer.fiscalAddress.province ?? ""}
          />
        </label>
        <div className="form-three-columns">
          <label>
            Forma de pago
            <select
              name="defaultPaymentMethod"
              required
              defaultValue={customer.commercialTerms.defaultPaymentMethod}
            >
              <option value="BANK_TRANSFER">Transferencia</option>
              <option value="CASH">Contado</option>
              <option value="DIRECT_DEBIT">Domiciliacion</option>
            </select>
          </label>
          <label>
            Vencimiento
            <select
              name="paymentTermsType"
              required
              defaultValue={customer.commercialTerms.paymentTermsType}
            >
              <option value="IMMEDIATE">Al contado</option>
              <option value="DAYS">A dias</option>
              <option value="FIXED_DAY_OF_MONTH">Dia fijo del mes</option>
            </select>
          </label>
          <label>
            Limite de credito
            <input
              name="creditLimit"
              inputMode="decimal"
              pattern="[0-9]+([.][0-9]{1,2})?"
              defaultValue={customer.commercialTerms.creditLimit ?? ""}
            />
          </label>
        </div>
        <div className="form-two-columns">
          <label>
            Dias de vencimiento
            <input
              name="paymentDays"
              type="number"
              min={1}
              max={365}
              defaultValue={customer.commercialTerms.paymentDays ?? ""}
            />
          </label>
          <label>
            Dia fijo
            <input
              name="paymentFixedDay"
              type="number"
              min={1}
              max={31}
            defaultValue={customer.commercialTerms.paymentFixedDay ?? ""}
            />
          </label>
        </div>
        <label>
          IBAN
          <input
            name="bankIban"
            autoComplete="off"
            inputMode="text"
            maxLength={40}
            placeholder="ES00 0000 0000 0000 0000 0000"
            defaultValue={customer.bankAccount.iban ?? ""}
          />
        </label>
        <div className="form-two-columns">
          <label>
            Referencia mandato SEPA
            <input
              name="sepaMandateReference"
              maxLength={80}
              defaultValue={customer.bankAccount.sepaMandate?.reference ?? ""}
            />
          </label>
          <label>
            Fecha firma SEPA
            <input
              name="sepaMandateSignedAt"
              type="date"
              defaultValue={customer.bankAccount.sepaMandate?.signedAt ?? ""}
            />
          </label>
        </div>
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

function nullableString(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function nullableNumber(value: FormDataEntryValue | null): number | null {
  const text = String(value ?? "").trim();
  return text ? Number(text) : null;
}

function nullableSepaMandate(
  formData: FormData
): { reference: string; signedAt: string } | null {
  const reference = String(formData.get("sepaMandateReference") ?? "").trim();
  const signedAt = String(formData.get("sepaMandateSignedAt") ?? "").trim();

  return reference || signedAt ? { reference, signedAt } : null;
}
