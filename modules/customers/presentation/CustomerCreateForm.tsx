"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export function CustomerCreateForm() {
  const router = useRouter();
  const [state, setState] = useState<SubmissionState>({ status: "idle" });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ status: "submitting" });

    const form = event.currentTarget;
    const formData = new FormData(form);
    const sepaMandate = optionalSepaMandate(formData);
    const csrfToken = await fetchCsrfToken();
    const response = await fetch("/api/customers", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
        "X-CSRF-Token": csrfToken
      },
      body: JSON.stringify({
        type: String(formData.get("type") ?? "COMPANY"),
        legalName: String(formData.get("legalName") ?? ""),
        tradeName: optionalString(formData.get("tradeName")),
        taxId: String(formData.get("taxId") ?? ""),
        fiscalTreatment: String(formData.get("fiscalTreatment") ?? "DOMESTIC"),
        email: optionalString(formData.get("email")),
        phone: optionalString(formData.get("phone")),
        fiscalAddressLine: String(formData.get("fiscalAddressLine") ?? ""),
        fiscalPostalCode: String(formData.get("fiscalPostalCode") ?? ""),
        fiscalCity: String(formData.get("fiscalCity") ?? ""),
        fiscalProvince: optionalString(formData.get("fiscalProvince")),
        fiscalCountry: String(formData.get("fiscalCountry") ?? "ES"),
        defaultPaymentMethod: String(formData.get("defaultPaymentMethod") ?? "BANK_TRANSFER"),
        paymentTermsType: String(formData.get("paymentTermsType") ?? "IMMEDIATE"),
        paymentDays: optionalNumber(formData.get("paymentDays")),
        paymentFixedDay: optionalNumber(formData.get("paymentFixedDay")),
        creditLimit: optionalString(formData.get("creditLimit")) ?? null,
        bankIban: optionalString(formData.get("bankIban")),
        ...(sepaMandate ? { sepaMandate } : {}),
        notes: optionalString(formData.get("notes"))
      })
    });

    if (response.ok) {
      form.reset();
      setState({
        status: "success",
        message: "Cliente creado."
      });
      router.refresh();
      return;
    }

    const body = (await response.json().catch(() => null)) as
      | { message?: string; code?: string; issues?: ValidationIssues }
      | null;

    setState({
      status: "error",
      message: customerValidationMessage(body) ?? "No se pudo crear el cliente."
    });
  }

  return (
    <form className="form-grid" onSubmit={handleSubmit}>
      <fieldset>
        <legend>Nuevo cliente</legend>
        <div className="form-two-columns">
          <label>
            Tipo
            <select name="type" required defaultValue="COMPANY">
              <option value="COMPANY">Empresa</option>
              <option value="SELF_EMPLOYED">Autonomo</option>
              <option value="INDIVIDUAL">Particular</option>
            </select>
          </label>
          <label>
            Fiscalidad
            <select name="fiscalTreatment" required defaultValue="DOMESTIC">
              <option value="DOMESTIC">Nacional</option>
              <option value="EU">Intracomunitario</option>
              <option value="EXPORT">Exportacion</option>
              <option value="CANARY_CEUTA_MELILLA">Canarias, Ceuta o Melilla</option>
            </select>
          </label>
        </div>
        <label>
          Razon social
          <input name="legalName" required minLength={2} maxLength={200} />
        </label>
        <div className="form-two-columns">
          <label>
            Nombre comercial
            <input name="tradeName" maxLength={160} />
          </label>
          <label>
            NIF / VAT
            <input name="taxId" required minLength={3} maxLength={32} />
          </label>
        </div>
        <div className="form-two-columns">
          <label>
            Email
            <input name="email" type="email" maxLength={254} />
          </label>
          <label>
            Telefono
            <input name="phone" maxLength={40} />
          </label>
        </div>
        <label>
          Direccion fiscal
          <input name="fiscalAddressLine" required minLength={3} maxLength={240} />
        </label>
        <div className="form-three-columns">
          <label>
            Codigo postal
            <input name="fiscalPostalCode" required minLength={2} maxLength={20} />
          </label>
          <label>
            Localidad
            <input name="fiscalCity" required minLength={2} maxLength={120} />
          </label>
          <label>
            Pais
            <input
              name="fiscalCountry"
              required
              minLength={2}
              maxLength={2}
              defaultValue="ES"
            />
          </label>
        </div>
        <label>
          Provincia
          <input name="fiscalProvince" maxLength={120} />
        </label>
        <div className="form-three-columns">
          <label>
            Forma de pago
            <select name="defaultPaymentMethod" required defaultValue="BANK_TRANSFER">
              <option value="BANK_TRANSFER">Transferencia</option>
              <option value="CASH">Contado</option>
              <option value="DIRECT_DEBIT">Domiciliacion</option>
            </select>
          </label>
          <label>
            Vencimiento
            <select name="paymentTermsType" required defaultValue="IMMEDIATE">
              <option value="IMMEDIATE">Al contado</option>
              <option value="DAYS">A dias</option>
              <option value="FIXED_DAY_OF_MONTH">Dia fijo del mes</option>
            </select>
          </label>
          <label>
            Limite de credito
            <input name="creditLimit" inputMode="decimal" pattern="[0-9]+([.][0-9]{1,2})?" />
          </label>
        </div>
        <div className="form-two-columns">
          <label>
            Dias de vencimiento
            <input name="paymentDays" type="number" min={1} max={365} />
          </label>
          <label>
            Dia fijo
            <input name="paymentFixedDay" type="number" min={1} max={31} />
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
          />
        </label>
        <div className="form-two-columns">
          <label>
            Referencia mandato SEPA
            <input name="sepaMandateReference" maxLength={80} />
          </label>
          <label>
            Fecha firma SEPA
            <input name="sepaMandateSignedAt" type="date" />
          </label>
        </div>
        <label>
          Observaciones
          <textarea name="notes" maxLength={1000} rows={3} />
        </label>
      </fieldset>

      <div className="form-actions">
        <button className="button" disabled={state.status === "submitting"} type="submit">
          {state.status === "submitting" ? "Creando..." : "Crear cliente"}
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

function optionalString(value: FormDataEntryValue | null): string | undefined {
  const text = String(value ?? "").trim();
  return text ? text : undefined;
}

function optionalNumber(value: FormDataEntryValue | null): number | null {
  const text = String(value ?? "").trim();
  return text ? Number(text) : null;
}

function optionalSepaMandate(
  formData: FormData
): { reference: string; signedAt: string } | null {
  const reference = String(formData.get("sepaMandateReference") ?? "").trim();
  const signedAt = String(formData.get("sepaMandateSignedAt") ?? "").trim();

  return reference || signedAt ? { reference, signedAt } : null;
}

type ValidationIssues = {
  formErrors?: unknown;
  fieldErrors?: unknown;
};

const customerFieldLabels: Record<string, string> = {
  type: "Tipo",
  legalName: "Razon social",
  tradeName: "Nombre comercial",
  taxId: "NIF / VAT",
  fiscalTreatment: "Fiscalidad",
  email: "Email",
  phone: "Telefono",
  fiscalAddressLine: "Direccion fiscal",
  fiscalPostalCode: "Codigo postal",
  fiscalCity: "Localidad",
  fiscalProvince: "Provincia",
  fiscalCountry: "Pais",
  defaultPaymentMethod: "Forma de pago",
  paymentTermsType: "Vencimiento",
  paymentDays: "Dias de vencimiento",
  paymentFixedDay: "Dia fijo",
  creditLimit: "Limite de credito",
  bankIban: "IBAN",
  sepaMandate: "Mandato SEPA",
  notes: "Observaciones"
};

function customerValidationMessage(
  body: { message?: string; code?: string; issues?: ValidationIssues } | null
): string | null {
  const fieldIssue = firstFieldIssue(body?.issues);

  if (fieldIssue) {
    return `${customerFieldLabels[fieldIssue.field] ?? fieldIssue.field}: ${fieldIssue.message}`;
  }

  return body?.message ?? body?.code ?? null;
}

function firstFieldIssue(
  issues: ValidationIssues | undefined
): { field: string; message: string } | null {
  if (!isRecord(issues?.fieldErrors)) {
    return null;
  }

  for (const [field, messages] of Object.entries(issues.fieldErrors)) {
    if (Array.isArray(messages) && typeof messages[0] === "string") {
      return { field, message: messages[0] };
    }
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
