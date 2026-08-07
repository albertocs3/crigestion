"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type State = { kind: "idle" | "pending" | "success" | "error"; message?: string };
type SupplierOption = { id: string; code: string; legalName: string };
type ItemOption = { id: string; code: string; name: string; costPrice: string; taxRateId: string };
type TaxOption = { id: string; code: string; name: string; rate: string };
type ExistingLine = { catalogItemId: string | null; description: string; quantity: string; unitPrice: string; discountPercent: string; discountAmount: string; purchaseAccountCode: string; taxRateId: string };
type Line = ExistingLine & { key: string };

async function mutate(url: string, method: "POST" | "PATCH" | "PUT", body: unknown, key: string): Promise<{ ok: boolean; status: number; message: string; value: unknown }> {
  const response = await fetch(url, { method, headers: { "Content-Type": "application/json", "Idempotency-Key": key, "X-CSRF-Token": await fetchCsrfToken() }, body: JSON.stringify(body) });
  const value = await response.json().catch(() => null) as { message?: string; code?: string } | null;
  return { ok: response.ok, status: response.status, message: value?.message ?? value?.code ?? (response.ok ? "Operación completada." : "No se pudo completar la operación."), value };
}

function useMutationKey() { const ref = useRef<string | null>(null); return { get: () => (ref.current ??= crypto.randomUUID()), clear: () => { ref.current = null; } }; }

export function PurchaseDraftCreateForm({ suppliers }: { suppliers: SupplierOption[] }) {
  const router = useRouter(); const [state, setState] = useState<State>({ kind: "idle" }); const key = useMutationKey();
  async function submit(formData: FormData) { setState({ kind: "pending" }); const result = await mutate("/api/purchases", "POST", { supplierId: String(formData.get("supplierId")), supplierInvoiceNumber: String(formData.get("supplierInvoiceNumber")), issueDate: String(formData.get("issueDate")), receivedDate: String(formData.get("receivedDate")), operationDate: String(formData.get("operationDate")), accountingDate: String(formData.get("accountingDate")), notes: String(formData.get("notes") || "").trim() || null }, key.get()); if (!result.ok) { if (result.status < 500) key.clear(); setState({ kind: "error", message: result.message }); return; } key.clear(); const created = result.value as { id: string }; router.push(`/app/purchases/${created.id}`); router.refresh(); }
  return <form className="stack" action={submit}><h2>Nueva factura de compra</h2><div className="form-grid"><label>Proveedor<select name="supplierId" required><option value="">Selecciona</option>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.code} - {supplier.legalName}</option>)}</select></label><label>Número proveedor<input name="supplierInvoiceNumber" required maxLength={80}/></label><label>Fecha emisión<input name="issueDate" type="date" required/></label><label>Fecha recepción<input name="receivedDate" type="date" required/></label><label>Fecha operación<input name="operationDate" type="date" required/></label><label>Fecha contable<input name="accountingDate" type="date" required/></label></div><label>Notas<textarea name="notes" maxLength={1000}/></label><button className="button" disabled={state.kind === "pending" || suppliers.length === 0}>{state.kind === "pending" ? "Creando…" : "Crear borrador"}</button>{state.message ? <p className={`message ${state.kind === "error" ? "error" : "success"}`}>{state.message}</p> : null}</form>;
}

const emptyLine = (taxRateId = ""): Line => ({ key: crypto.randomUUID(), catalogItemId: null, description: "", quantity: "1", unitPrice: "0.00", discountPercent: "0", discountAmount: "0", purchaseAccountCode: "600000000", taxRateId });

export function PurchaseLinesForm({ purchaseId, version, items, taxRates, existing }: { purchaseId: string; version: number; items: ItemOption[]; taxRates: TaxOption[]; existing: ExistingLine[] }) {
  const router = useRouter(); const key = useMutationKey(); const [state, setState] = useState<State>({ kind: "idle" }); const [lines, setLines] = useState<Line[]>(existing.length ? existing.map((line) => ({ ...line, key: crypto.randomUUID() })) : [emptyLine(taxRates[0]?.id)]);
  function update(index: number, values: Partial<Line>) { setLines((current) => current.map((line, position) => position === index ? { ...line, ...values } : line)); }
  function selectItem(index: number, id: string) { const item = items.find((candidate) => candidate.id === id); update(index, item ? { catalogItemId: item.id, description: item.name, unitPrice: item.costPrice, taxRateId: item.taxRateId } : { catalogItemId: null }); }
  async function save() { setState({ kind: "pending" }); const result = await mutate(`/api/purchases/${purchaseId}/lines`, "PUT", { expectedVersion: version, lines: lines.map(({ key: rowKey, ...line }) => { void rowKey; return line; }) }, key.get()); if (!result.ok) { if (result.status < 500) key.clear(); setState({ kind: "error", message: result.message }); return; } key.clear(); setState({ kind: "success", message: "Líneas guardadas." }); router.refresh(); }
  return <div className="stack"><div className="split-header"><div><h2>Líneas</h2><p className="muted">La cuenta 600000000 puede cambiarse por otra subcuenta de compra.</p></div><button className="button button-secondary" type="button" onClick={() => setLines((current) => [...current, emptyLine(taxRates[0]?.id)])}>Añadir línea</button></div>{lines.map((line, index) => <fieldset className="panel stack" key={line.key}><legend>Línea {index + 1}</legend><div className="form-grid"><label>Artículo<select value={line.catalogItemId ?? ""} onChange={(event) => selectItem(index, event.target.value)}><option value="">Línea manual</option>{items.map((item) => <option key={item.id} value={item.id}>{item.code} - {item.name}</option>)}</select></label><label>Descripción<input value={line.description} maxLength={500} onChange={(event) => update(index, { description: event.target.value })}/></label><label>Cantidad<input value={line.quantity} inputMode="decimal" onChange={(event) => update(index, { quantity: event.target.value })}/></label><label>Precio unitario<input value={line.unitPrice} inputMode="decimal" onChange={(event) => update(index, { unitPrice: event.target.value })}/></label><label>Descuento %<input value={line.discountPercent} inputMode="decimal" onChange={(event) => update(index, { discountPercent: event.target.value })}/></label><label>Descuento fijo<input value={line.discountAmount} inputMode="decimal" onChange={(event) => update(index, { discountAmount: event.target.value })}/></label><label>Subcuenta compra<input value={line.purchaseAccountCode} pattern="[0-9]{9}" onChange={(event) => update(index, { purchaseAccountCode: event.target.value })}/></label><label>IVA<select value={line.taxRateId} onChange={(event) => update(index, { taxRateId: event.target.value })}>{taxRates.map((tax) => <option key={tax.id} value={tax.id}>{tax.name} ({tax.rate}%)</option>)}</select></label></div>{lines.length > 1 ? <button className="button button-danger button-small" type="button" onClick={() => setLines((current) => current.filter((_, position) => position !== index))}>Quitar</button> : null}</fieldset>)}<button className="button" type="button" disabled={state.kind === "pending"} onClick={save}>{state.kind === "pending" ? "Guardando…" : "Guardar líneas"}</button>{state.message ? <p className={`message ${state.kind === "error" ? "error" : "success"}`}>{state.message}</p> : null}</div>;
}

export function PurchaseDueDatesForm({ purchaseId, version, total, issueDate, existing }: { purchaseId: string; version: number; total: string; issueDate: string; existing: Array<{ dueDate: string; amount: string; paymentMethod: "BANK_TRANSFER" | "CASH" | "DIRECT_DEBIT" }> }) {
  const router = useRouter(); const key = useMutationKey(); const [state, setState] = useState<State>({ kind: "idle" }); const [rows, setRows] = useState(existing.length ? existing : [{ dueDate: issueDate, amount: total, paymentMethod: "BANK_TRANSFER" as const }]);
  function update(index: number, value: Partial<(typeof rows)[number]>) { setRows((current) => current.map((row, position) => position === index ? { ...row, ...value } : row)); }
  async function save() { setState({ kind: "pending" }); const result = await mutate(`/api/purchases/${purchaseId}/due-dates`, "PUT", { expectedVersion: version, dueDates: rows }, key.get()); if (!result.ok) { if (result.status < 500) key.clear(); setState({ kind: "error", message: result.message }); return; } key.clear(); setState({ kind: "success", message: "Vencimientos guardados." }); router.refresh(); }
  return <div className="stack"><div className="split-header"><div><h2>Vencimientos</h2><p className="muted">Deben sumar {total} EUR.</p></div><button className="button button-secondary" type="button" onClick={() => setRows((current) => [...current, { dueDate: issueDate, amount: "0.00", paymentMethod: "BANK_TRANSFER" }])}>Añadir</button></div>{rows.map((row, index) => <div className="form-grid" key={index}><label>Fecha<input type="date" min={issueDate} value={row.dueDate} onChange={(event) => update(index, { dueDate: event.target.value })}/></label><label>Importe<input inputMode="decimal" value={row.amount} onChange={(event) => update(index, { amount: event.target.value })}/></label><label>Método<select value={row.paymentMethod} onChange={(event) => update(index, { paymentMethod: event.target.value as typeof row.paymentMethod })}><option value="BANK_TRANSFER">Transferencia</option><option value="CASH">Efectivo</option><option value="DIRECT_DEBIT">Domiciliación</option></select></label>{rows.length > 1 ? <button className="button button-danger button-small" type="button" onClick={() => setRows((current) => current.filter((_, position) => position !== index))}>Quitar</button> : null}</div>)}<button className="button" type="button" disabled={state.kind === "pending"} onClick={save}>{state.kind === "pending" ? "Guardando…" : "Guardar vencimientos"}</button>{state.message ? <p className={`message ${state.kind === "error" ? "error" : "success"}`}>{state.message}</p> : null}</div>;
}

export function PurchaseRegisterButton({ purchaseId, version, disabled }: { purchaseId: string; version: number; disabled: boolean }) { const router = useRouter(); const key = useMutationKey(); const [state, setState] = useState<State>({ kind: "idle" }); async function register() { if (!window.confirm("¿Registrar definitivamente la factura de compra? Después será inmutable.")) return; setState({ kind: "pending" }); const result = await mutate(`/api/purchases/${purchaseId}/register`, "POST", { expectedVersion: version }, key.get()); if (!result.ok) { if (result.status < 500) key.clear(); setState({ kind: "error", message: result.message }); return; } key.clear(); setState({ kind: "success", message: "Compra registrada." }); router.refresh(); } return <div className="stack"><button className="button" type="button" disabled={disabled || state.kind === "pending"} onClick={register}>{state.kind === "pending" ? "Registrando…" : "Registrar compra"}</button>{state.message ? <p className={`message ${state.kind === "error" ? "error" : "success"}`}>{state.message}</p> : null}</div>; }

export function PurchaseRectificationForm({ purchaseId, version, originalNumber, originalTotal, createsSupplierCredit }: { purchaseId: string; version: number; originalNumber: string; originalTotal: string; createsSupplierCredit: boolean }) {
  const router = useRouter(); const key = useMutationKey(); const [state, setState] = useState<State>({ kind: "idle" });
  async function submit(formData: FormData) {
    const effect = createsSupplierCredit
      ? "Se conservarán sus pagos y vencimientos, y se generará un crédito de proveedor."
      : "Se cancelarán sus vencimientos pendientes.";
    if (!window.confirm(`¿Registrar la rectificación total de ${originalNumber}? ${effect} Se invertirán contabilidad, IVA y stock.`)) return;
    setState({ kind: "pending" });
    const result = await mutate(`/api/purchases/${purchaseId}/rectifications`, "POST", {
      mode: "FULL", expectedVersion: version, supplierInvoiceNumber: String(formData.get("supplierInvoiceNumber")),
      issueDate: String(formData.get("issueDate")), receivedDate: String(formData.get("receivedDate")),
      operationDate: String(formData.get("operationDate")), accountingDate: String(formData.get("accountingDate")),
      reason: String(formData.get("reason")), notes: String(formData.get("notes") || "").trim() || null
    }, key.get());
    if (!result.ok) { if (result.status < 500) key.clear(); setState({ kind: "error", message: result.message }); return; }
    key.clear(); const created = result.value as { id: string }; router.push(`/app/purchases/${created.id}`); router.refresh();
  }
  return <form className="stack" action={submit}>
    <h2>Rectificación total del proveedor</h2>
    <p className="muted">Creará un documento nuevo por -{originalTotal} EUR. No reescribe importes, líneas, IVA, asiento ni movimientos originales. {createsSupplierCredit ? "Conservará los pagos y vencimientos, y generará un crédito disponible del proveedor." : "Marcará el original como rectificado y cancelará sus vencimientos pendientes."}</p>
    <div className="form-grid">
      <label>Número de la rectificativa<input name="supplierInvoiceNumber" required maxLength={80}/></label>
      <label>Motivo<select name="reason" defaultValue="RETURN"><option value="RETURN">Devolución completa</option><option value="OPERATION_CANCELLED">Operación cancelada</option></select></label>
      <label>Fecha emisión<input name="issueDate" type="date" required/></label>
      <label>Fecha recepción<input name="receivedDate" type="date" required/></label>
      <label>Fecha operación<input name="operationDate" type="date" required/></label>
      <label>Fecha contable<input name="accountingDate" type="date" required/></label>
    </div>
    <label>Notas<textarea name="notes" maxLength={1000}/></label>
    <button className="button button-danger" disabled={state.kind === "pending"}>{state.kind === "pending" ? "Rectificando…" : "Registrar rectificación total"}</button>
    {state.message ? <p className={`message ${state.kind === "error" ? "error" : "success"}`}>{state.message}</p> : null}
  </form>;
}

export function PurchaseCorrectionVoidForm({ purchaseId, version, originalNumber, issueDate }: { purchaseId: string; version: number; originalNumber: string; issueDate: string }) {
  const router = useRouter(); const key = useMutationKey(); const [state, setState] = useState<State>({ kind: "idle" });
  async function submit(formData: FormData) {
    if (!window.confirm(`¿Anular internamente la compra ${originalNumber}? Se crearán contraasientos y ajustes inversos de IVA y stock. Esta acción no sustituye una rectificativa del proveedor.`)) return;
    setState({ kind: "pending" });
    const result = await mutate(`/api/purchases/${purchaseId}/corrections`, "POST", {
      mode: "VOID", expectedVersion: version, accountingDate: String(formData.get("accountingDate")),
      reasonCode: String(formData.get("reasonCode")), reason: String(formData.get("reason") || "").trim() || null,
      confirmation: "VOID_PURCHASE_WITHOUT_FINANCIAL_ACTIVITY"
    }, key.get());
    if (!result.ok) { if (result.status < 500) key.clear(); setState({ kind: "error", message: result.message }); return; }
    key.clear(); setState({ kind: "success", message: "Compra anulada con evidencias inversas." }); router.refresh();
  }
  return <form className="stack" action={submit}>
    <h2>Anulación interna</h2>
    <p className="muted">Disponible solo sin pagos, compensaciones ni rectificativas. Conserva la factura original y añade evidencias inversas; no registra un documento fiscal del proveedor.</p>
    <div className="form-grid">
      <label>Fecha contable<input name="accountingDate" type="date" min={issueDate} required/></label>
      <label>Motivo<select name="reasonCode" defaultValue="DUPLICATE_DOCUMENT"><option value="DUPLICATE_DOCUMENT">Documento duplicado</option></select></label>
    </div>
    <label>Detalle<textarea name="reason" maxLength={500}/></label>
    <button className="button button-danger" disabled={state.kind === "pending"}>{state.kind === "pending" ? "Anulando…" : "Anular compra"}</button>
    {state.message ? <p className={`message ${state.kind === "error" ? "error" : "success"}`} role="status">{state.message}</p> : null}
  </form>;
}

export function PurchaseCorrectionReplaceForm({ purchaseId, version, originalNumber, dates, items, taxRates, existingLines, existingDueDates }: {
  purchaseId: string; version: number; originalNumber: string; dates: { issueDate: string; receivedDate: string; operationDate: string; accountingDate: string };
  items: ItemOption[]; taxRates: TaxOption[]; existingLines: ExistingLine[];
  existingDueDates: Array<{ dueDate: string; amount: string; paymentMethod: "BANK_TRANSFER" | "CASH" | "DIRECT_DEBIT" }>;
}) {
  const router = useRouter(); const key = useMutationKey(); const [state, setState] = useState<State>({ kind: "idle" });
  const [lines, setLines] = useState<Line[]>(existingLines.map((line) => ({ ...line, key: crypto.randomUUID() })));
  const [dueDates, setDueDates] = useState(existingDueDates);
  const previewTotal = lines.reduce((sum, line) => { const subtotal = Number(line.quantity) * Number(line.unitPrice); const base = Math.max(0, subtotal - subtotal * Number(line.discountPercent) / 100 - Number(line.discountAmount)); const rate = Number(taxRates.find((tax) => tax.id === line.taxRateId)?.rate ?? 0); return sum + base + base * rate / 100; }, 0);
  const previewDueTotal = dueDates.reduce((sum, due) => sum + Number(due.amount), 0);
  function updateLine(index: number, values: Partial<Line>) { setLines((current) => current.map((line, position) => position === index ? { ...line, ...values } : line)); }
  function selectItem(index: number, id: string) { const item = items.find((candidate) => candidate.id === id); updateLine(index, item ? { catalogItemId: item.id, description: item.name, unitPrice: item.costPrice, taxRateId: item.taxRateId } : { catalogItemId: null }); }
  function updateDue(index: number, values: Partial<(typeof dueDates)[number]>) { setDueDates((current) => current.map((due, position) => position === index ? { ...due, ...values } : due)); }
  async function submit(formData: FormData) {
    if (!window.confirm(`¿Sustituir internamente la compra ${originalNumber} por una versión estimada en ${previewTotal.toFixed(2)} EUR, con ${lines.length} líneas y ${dueDates.length} vencimientos? La versión actual quedará histórica.`)) return;
    setState({ kind: "pending" }); const accountingDate = String(formData.get("accountingDate"));
    const result = await mutate(`/api/purchases/${purchaseId}/corrections`, "POST", { mode: "REPLACE", expectedVersion: version, accountingDate,
      reasonCode: String(formData.get("reasonCode")), reason: String(formData.get("reason") || "").trim() || null,
      confirmation: "REPLACE_PURCHASE_WITHOUT_FINANCIAL_ACTIVITY", replacement: { issueDate: String(formData.get("issueDate")), receivedDate: String(formData.get("receivedDate")),
        operationDate: String(formData.get("operationDate")), accountingDate, notes: String(formData.get("notes") || "").trim() || null,
        lines: lines.map(({ key: rowKey, ...line }) => { void rowKey; return line; }), dueDates } }, key.get());
    if (!result.ok) { if (result.status < 500) key.clear(); setState({ kind: "error", message: result.message }); return; }
    key.clear(); const value = result.value as { replacementPurchaseInvoiceId: string }; router.push(`/app/purchases/${value.replacementPurchaseInvoiceId}`); router.refresh();
  }
  return <form className="stack" action={submit}>
    <h2>Sustituir por una versión corregida</h2><p className="muted">Solo para errores internos sin actividad financiera. Conserva proveedor y número, deja la versión actual como sustituida y registra una nueva versión completa.</p>
    <div className="form-grid"><label>Motivo<select name="reasonCode" defaultValue="DATA_ENTRY_ERROR"><option value="DATA_ENTRY_ERROR">Error de captura</option><option value="WRONG_DATE">Fecha incorrecta</option><option value="WRONG_AMOUNT">Importe incorrecto</option><option value="WRONG_TAX">IVA incorrecto</option><option value="OTHER">Otro</option></select></label><label>Fecha emisión<input name="issueDate" type="date" defaultValue={dates.issueDate} required/></label><label>Fecha recepción<input name="receivedDate" type="date" defaultValue={dates.receivedDate} required/></label><label>Fecha operación<input name="operationDate" type="date" defaultValue={dates.operationDate} required/></label><label>Fecha contable de corrección y reemplazo<input name="accountingDate" type="date" min={dates.accountingDate} defaultValue={dates.accountingDate} required/></label></div>
    <label>Explicación del cambio<textarea name="reason" maxLength={500}/></label><label>Notas de la nueva versión<textarea name="notes" maxLength={1000}/></label>
    <p className={Math.abs(previewTotal - previewDueTotal) < 0.005 ? "message success" : "message error"} role="status">Resumen previo: {lines.length} líneas, total estimado {previewTotal.toFixed(2)} EUR; {dueDates.length} vencimientos por {previewDueTotal.toFixed(2)} EUR.</p>
    <div className="split-header"><h3>Líneas corregidas</h3><button className="button button-secondary button-small" type="button" onClick={() => setLines((current) => [...current, emptyLine(taxRates[0]?.id)])}>Añadir línea</button></div>
    {lines.map((line, index) => <fieldset className="panel stack" key={line.key}><legend>Línea {index + 1}</legend><div className="form-grid"><label>Artículo<select value={line.catalogItemId ?? ""} onChange={(event) => selectItem(index, event.target.value)}><option value="">Línea manual</option>{items.map((item) => <option key={item.id} value={item.id}>{item.code} - {item.name}</option>)}</select></label><label>Descripción<input value={line.description} maxLength={500} required onChange={(event) => updateLine(index, { description: event.target.value })}/></label><label>Cantidad<input value={line.quantity} inputMode="decimal" required onChange={(event) => updateLine(index, { quantity: event.target.value })}/></label><label>Precio unitario<input value={line.unitPrice} inputMode="decimal" required onChange={(event) => updateLine(index, { unitPrice: event.target.value })}/></label><label>Descuento %<input value={line.discountPercent} inputMode="decimal" required onChange={(event) => updateLine(index, { discountPercent: event.target.value })}/></label><label>Descuento fijo<input value={line.discountAmount} inputMode="decimal" required onChange={(event) => updateLine(index, { discountAmount: event.target.value })}/></label><label>Subcuenta compra<input value={line.purchaseAccountCode} pattern="[0-9]{9}" required onChange={(event) => updateLine(index, { purchaseAccountCode: event.target.value })}/></label><label>IVA<select value={line.taxRateId} required onChange={(event) => updateLine(index, { taxRateId: event.target.value })}>{taxRates.map((tax) => <option key={tax.id} value={tax.id}>{tax.name} ({tax.rate}%)</option>)}</select></label></div>{lines.length > 1 ? <button className="button button-danger button-small" type="button" onClick={() => setLines((current) => current.filter((_, position) => position !== index))}>Quitar línea</button> : null}</fieldset>)}
    <div className="split-header"><div><h3>Vencimientos corregidos</h3><p className="muted">La suma debe coincidir con el total calculado de las líneas.</p></div><button className="button button-secondary button-small" type="button" onClick={() => setDueDates((current) => [...current, { dueDate: dates.issueDate, amount: "0.00", paymentMethod: "BANK_TRANSFER" }])}>Añadir vencimiento</button></div>
    {dueDates.map((due, index) => <div className="form-grid" key={index}><label>Fecha<input type="date" value={due.dueDate} required onChange={(event) => updateDue(index, { dueDate: event.target.value })}/></label><label>Importe<input value={due.amount} inputMode="decimal" required onChange={(event) => updateDue(index, { amount: event.target.value })}/></label><label>Método<select value={due.paymentMethod} onChange={(event) => updateDue(index, { paymentMethod: event.target.value as typeof due.paymentMethod })}><option value="BANK_TRANSFER">Transferencia</option><option value="CASH">Efectivo</option><option value="DIRECT_DEBIT">Domiciliación</option></select></label>{dueDates.length > 1 ? <button className="button button-danger button-small" type="button" onClick={() => setDueDates((current) => current.filter((_, position) => position !== index))}>Quitar</button> : null}</div>)}
    <button className="button button-danger" disabled={state.kind === "pending" || !lines.length || !dueDates.length}>{state.kind === "pending" ? "Sustituyendo…" : "Crear versión corregida"}</button>
    {state.message ? <p className={`message ${state.kind === "error" ? "error" : "success"}`} role="status">{state.message}</p> : null}
  </form>;
}

export function SupplierPaymentForm({ dueDate }: { dueDate: { id: string; supplierId: string; pendingAmount: string; paymentMethod: "BANK_TRANSFER" | "CASH" | "DIRECT_DEBIT" } }) { const router = useRouter(); const key = useMutationKey(); const [state, setState] = useState<State>({ kind: "idle" }); async function submit(formData: FormData) { setState({ kind: "pending" }); const result = await mutate("/api/treasury/supplier-payments", "POST", { supplierId: dueDate.supplierId, paymentDate: String(formData.get("paymentDate")), paymentMethod: String(formData.get("paymentMethod")), reference: String(formData.get("reference") || "").trim() || null, notes: null, allocations: [{ dueDateId: dueDate.id, amount: String(formData.get("amount")) }] }, key.get()); if (!result.ok) { if (result.status < 500) key.clear(); setState({ kind: "error", message: result.message }); return; } key.clear(); setState({ kind: "success", message: "Pago registrado." }); router.refresh(); } return <form className="compact-stack" action={submit}><label>Fecha<input name="paymentDate" type="date" required/></label><label>Importe<input name="amount" defaultValue={dueDate.pendingAmount} inputMode="decimal" required/></label><label>Método<select name="paymentMethod" defaultValue={dueDate.paymentMethod}><option value="BANK_TRANSFER">Transferencia</option><option value="CASH">Efectivo</option><option value="DIRECT_DEBIT">Domiciliación</option></select></label><label>Referencia<input name="reference" maxLength={120} placeholder="Opcional"/></label><button className="button button-small" disabled={state.kind === "pending"}>{state.kind === "pending" ? "Registrando…" : "Pagar"}</button>{state.message ? <small className={state.kind === "error" ? "message error" : "message success"}>{state.message}</small> : null}</form>; }
