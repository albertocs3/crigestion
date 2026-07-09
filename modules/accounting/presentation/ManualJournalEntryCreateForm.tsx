"use client";

import { FormEvent, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { AccountingAccountDto } from "@/modules/accounting/application/journal";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

type ManualJournalEntryCreateFormProps = {
  accounts: AccountingAccountDto[];
};

export function ManualJournalEntryCreateForm({
  accounts
}: ManualJournalEntryCreateFormProps) {
  const router = useRouter();
  const [state, setState] = useState<SubmissionState>({ status: "idle" });
  const disabled = state.status === "submitting";
  const postableAccounts = useMemo(
    () =>
      accounts.filter(
        (account) => account.status === "ACTIVE" && account.isPostable
      ),
    [accounts]
  );
  const hasEnoughAccounts = postableAccounts.length >= 2;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ status: "submitting" });

    const form = event.currentTarget;
    const formData = new FormData(form);
    const concept = String(formData.get("concept") ?? "");
    const amount = String(formData.get("amount") ?? "");
    const csrfToken = await fetchCsrfToken();
    const response = await fetch("/api/accounting/journal-entries", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
        "X-CSRF-Token": csrfToken
      },
      body: JSON.stringify({
        accountingDate: String(formData.get("accountingDate") ?? ""),
        concept,
        lines: [
          {
            accountId: String(formData.get("debitAccountId") ?? ""),
            concept,
            debit: amount,
            credit: "0.00"
          },
          {
            accountId: String(formData.get("creditAccountId") ?? ""),
            concept,
            debit: "0.00",
            credit: amount
          }
        ]
      })
    });

    if (response.ok) {
      form.reset();
      setState({ status: "success", message: "Asiento creado." });
      router.refresh();
      return;
    }

    const body = (await response.json().catch(() => null)) as
      | { message?: string; code?: string }
      | null;

    setState({
      status: "error",
      message: body?.message ?? body?.code ?? "No se pudo crear el asiento."
    });
  }

  return (
    <form className="form-grid" onSubmit={handleSubmit}>
      <fieldset disabled={disabled || !hasEnoughAccounts}>
        <legend>Nuevo asiento manual</legend>
        <div className="form-three-columns">
          <label>
            Fecha contable
            <input
              name="accountingDate"
              type="date"
              required
              defaultValue={new Date().toISOString().slice(0, 10)}
            />
          </label>
          <label>
            Concepto
            <input name="concept" required maxLength={240} />
          </label>
          <label>
            Importe
            <input
              name="amount"
              inputMode="decimal"
              required
              pattern="\d{1,12}(\.\d{1,2})?"
              placeholder="121.00"
            />
          </label>
        </div>
        <div className="form-two-columns">
          <label>
            Cuenta debe
            <select name="debitAccountId" required defaultValue="">
              <option value="" disabled>
                Selecciona cuenta
              </option>
              {postableAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.code} - {account.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Cuenta haber
            <select name="creditAccountId" required defaultValue="">
              <option value="" disabled>
                Selecciona cuenta
              </option>
              {postableAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.code} - {account.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </fieldset>
      {!hasEnoughAccounts ? (
        <p className="message error">No hay suficientes cuentas imputables activas.</p>
      ) : null}
      <div className="form-actions">
        <button
          className="button"
          disabled={disabled || !hasEnoughAccounts}
          type="submit"
        >
          {state.status === "submitting" ? "Creando..." : "Crear asiento"}
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
