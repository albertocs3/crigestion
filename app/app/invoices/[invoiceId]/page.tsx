import Link from "next/link";
import { z } from "zod";
import {
  getInvoiceDetail,
  type InvoiceDetail
} from "@/modules/billing/application/invoices";
import { InvoiceIssueButton } from "@/modules/billing/presentation/InvoiceIssueButton";
import { InvoiceDueDatesForm } from "@/modules/billing/presentation/InvoiceDueDatesForm";
import { InvoiceLineCreateForm } from "@/modules/billing/presentation/InvoiceLineCreateForm";
import { InvoiceRectificationCreateForm } from "@/modules/billing/presentation/InvoiceRectificationCreateForm";
import { InvoiceTechnicalVoidingForm } from "@/modules/billing/presentation/InvoiceTechnicalVoidingForm";
import { VerifactuCancellationForm } from "@/modules/billing/presentation/VerifactuCancellationForm";
import { listCatalogItems } from "@/modules/catalog/application/items";
import { listCatalogTaxRates } from "@/modules/catalog/application/taxRates";
import { authorizePagePermission } from "@/modules/platform/presentation/pageAccess";
import { CustomerPaymentRegisterForm } from "@/modules/treasury/presentation/CustomerPaymentRegisterForm";
import { CustomerPaymentReturnRegisterForm } from "@/modules/treasury/presentation/CustomerPaymentReturnRegisterForm";
import { CustomerDueDateUnpaidForm } from "@/modules/treasury/presentation/CustomerDueDateUnpaidForm";

export const dynamic = "force-dynamic";

type InvoiceDetailPageProps = {
  params: Promise<{
    invoiceId: string;
  }>;
};

const paramsSchema = z.object({
  invoiceId: z.string().uuid()
});

export default async function InvoiceDetailPage({ params }: InvoiceDetailPageProps) {
  const authorization = await authorizePagePermission("Billing.View");
  const parsedParams = paramsSchema.safeParse(await params);

  if (!authorization.ok) {
    return (
      <main className="shell">
        <header className="topbar">
          <div className="brand">CriGestión</div>
          <Link className="button button-secondary" href="/app/invoices">
            Volver
          </Link>
        </header>
        <section className="content">
          <div className="panel stack">
            <h1>Factura</h1>
            <p className="message error">{authorization.message}</p>
          </div>
        </section>
      </main>
    );
  }

  if (!parsedParams.success) {
    return (
      <main className="shell">
        <header className="topbar">
          <div className="brand">CriGestión</div>
          <Link className="button button-secondary" href="/app/invoices">
            Volver
          </Link>
        </header>
        <section className="content">
          <div className="panel stack">
            <h1>Factura</h1>
            <p className="message error">Identificador de factura invalido.</p>
          </div>
        </section>
      </main>
    );
  }

  const invoice = await getInvoiceDetail(parsedParams.data.invoiceId, authorization.user);

  if (!invoice) {
    return (
      <main className="shell">
        <header className="topbar">
          <div className="brand">CriGestión</div>
          <Link className="button button-secondary" href="/app/invoices">
            Volver
          </Link>
        </header>
        <section className="content">
          <div className="panel stack">
            <h1>Factura</h1>
            <p className="message error">La factura no existe.</p>
          </div>
        </section>
      </main>
    );
  }

  const canManageDrafts = authorization.user.permissions.includes("Billing.ManageDrafts");
  const canIssue = authorization.user.permissions.includes("Billing.Issue");
  const canManagePayments = authorization.user.permissions.includes(
    "Treasury.ManagePayments"
  );
  const canViewAccounting = authorization.user.permissions.includes("Accounting.View");
  const canViewVerifactuOperations = authorization.user.permissions.includes("Billing.ViewVerifactuOperations");
  const canRequestVerifactuCancellation = authorization.user.permissions.includes("Billing.RequestVerifactuCancellation");
  const canFinalizeVerifactuCancellation = authorization.user.permissions.includes("Billing.FinalizeVerifactuCancellation");
  const items = canManageDrafts
    ? await listCatalogItems({ limit: 100, status: "ACTIVE" }, authorization.user)
    : { items: [], nextCursor: null };
  const taxRates = canManageDrafts
    ? await listCatalogTaxRates({ includeInactive: false })
    : [];
  const editable = invoice.status === "DRAFT";
  const issueDisabled = !editable || invoice.lines.length === 0;
  const canCreateRectification =
    canIssue &&
    invoice.documentType === "STANDARD" &&
    invoice.status === "ISSUED" &&
    (invoice.verifactuStatus === "NOT_APPLICABLE" || invoice.verifactuStatus === "ACCEPTED" || invoice.verifactuStatus === "ACCEPTED_WITH_ERRORS") &&
    invoice.rectificationInvoices.length === 0;
  const technicalVoidingEligible =
    invoice.documentType === "STANDARD" &&
    invoice.status === "ISSUED" &&
    invoice.verifactuStatus === "CANCELLED" &&
    invoice.verifactuTrace?.recordType === "ANULACION" &&
    invoice.verifactuTrace.operationalStatus === "COMPLETED" &&
    (invoice.verifactuTrace.latestAttempt?.outcome === "ACCEPTED" || invoice.verifactuTrace.latestAttempt?.outcome === "ACCEPTED_WITH_ERRORS") &&
    invoice.verifactuTrace.cancellationReasonCode === "ISSUED_BY_MISTAKE" &&
    invoice.rectificationInvoices.length === 0 &&
    invoice.accountingEntry !== null &&
    invoice.payments.length === 0 &&
    invoice.paymentReturns.length === 0 &&
    invoice.dueDates.every((dueDate) => dueDate.status === "PENDING" && !dueDate.remittance);

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">CriGestión</div>
        <div className="button-row">
          <Link className="button button-secondary" href="/app/invoices">
            Facturas
          </Link>
          <Link className="button button-secondary" href="/app">
            Inicio
          </Link>
        </div>
      </header>
      <section className="content stack">
        {invoice.status !== "DRAFT" ? (
          <nav className="panel flow-trace" aria-label="Trazabilidad de factura y cobro">
            <ol>
              <li>
                <span>1</span>
                <strong>Factura emitida</strong>
                <small>{invoice.number}</small>
              </li>
              <li>
                <span>2</span>
                <strong>Vencimientos</strong>
                <small>{invoice.dueDates.length} programados</small>
              </li>
              <li>
                <span>3</span>
                <strong>Cobro o remesa</strong>
                <small>{paymentStatusLabel(invoice.paymentStatus)}</small>
              </li>
              <li>
                <span>4</span>
                <strong>Contabilidad</strong>
                <small>{invoice.payments.filter((payment) => payment.accountingEntry).length + invoice.paymentReturns.filter((paymentReturn) => paymentReturn.accountingEntry).length + (invoice.accountingEntry ? 1 : 0)} asientos</small>
              </li>
            </ol>
            <div className="button-row">
              {canManagePayments ? (
                <Link className="button button-secondary button-small" href={`/app/treasury?search=${encodeURIComponent(invoice.number ?? "")}`}>
                  Ver vencimientos en Tesoreria
                </Link>
              ) : null}
              {canManagePayments ? (
                <Link className="button button-secondary button-small" href="/app/treasury/remittances">
                  Ver remesas
                </Link>
              ) : null}
              {canViewAccounting && invoice.accountingEntry ? (
                <Link className="button button-secondary button-small" href={`/app/accounting?entryId=${invoice.accountingEntry.id}`}>
                  Asiento {invoice.accountingEntry.number}
                </Link>
              ) : null}
            </div>
          </nav>
        ) : null}
        <div className="panel stack">
          <div className="split-header">
            <div>
              <h1>{invoice.number ?? "Borrador de factura"}</h1>
              <p className="muted">
                {documentTypeLabel(invoice.documentType)} -{" "}
                {invoice.customerSnapshot.code} - {invoice.customerSnapshot.legalName}
              </p>
            </div>
            <div className="button-row">
              {invoice.status !== "DRAFT" ? (
                <Link
                  className="button button-secondary"
                  href={`/api/invoices/${invoice.id}/pdf`}
                  target="_blank"
                >
                  Descargar PDF
                </Link>
              ) : null}
              {renderStatus(invoice.status)}
            </div>
          </div>

          <div className="data-grid">
            <div>
              <span className="data-label">Fecha emision</span>
              <strong>{formatDate(invoice.issueDate)}</strong>
            </div>
            <div>
              <span className="data-label">Fecha operacion</span>
              <strong>{formatDate(invoice.operationDate)}</strong>
            </div>
            <div>
              <span className="data-label">Total</span>
              <strong>{formatMoney(invoice.totals.total)}</strong>
            </div>
            {invoice.rectificationReason ? (
              <div>
                <span className="data-label">Motivo rectificacion</span>
                <strong>{rectificationReasonLabel(invoice.rectificationReason)}</strong>
              </div>
            ) : null}
            {invoice.rectifiesInvoice ? (
              <div>
                <span className="data-label">Rectifica a</span>
                <strong>
                  <Link href={`/app/invoices/${invoice.rectifiesInvoice.id}`}>
                    {invoice.rectifiesInvoice.number ?? "Factura original"}
                  </Link>
                </strong>
              </div>
            ) : null}
            {invoice.rectificationInvoices.length > 0 ? (
              <div>
                <span className="data-label">Rectificativa</span>
                <strong>
                  <Link href={`/app/invoices/${invoice.rectificationInvoices[0]?.id}`}>
                    {invoice.rectificationInvoices[0]?.number ?? "Abrir rectificativa"}
                  </Link>
                </strong>
              </div>
            ) : null}
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Linea</th>
                  <th>Cantidad</th>
                  <th>Precio</th>
                  <th>Descuento</th>
                  <th>IVA</th>
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {invoice.lines.length === 0 ? (
                  <tr>
                    <td colSpan={6}>Todavia no hay lineas.</td>
                  </tr>
                ) : (
                  invoice.lines.map((line) => (
                    <tr key={line.id}>
                      <td>
                        <strong>{line.description}</strong>
                        <span className="cell-detail">Linea {line.position}</span>
                      </td>
                      <td>{line.quantity}</td>
                      <td>{formatMoney(line.unitPrice)}</td>
                      <td>
                        {line.discountPercent}%<span className="cell-detail">{formatMoney(line.discountAmount)}</span>
                      </td>
                      <td>
                        {line.taxRate.name}
                        <span className="cell-detail">{line.taxRate.rate}%</span>
                      </td>
                      <td>{formatMoney(line.totals.total)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {canViewVerifactuOperations && invoice.verifactuTrace ? <section className="credential-installation stack" aria-labelledby="invoice-verifactu-trace-heading">
            <div className="split-header"><div><h3 id="invoice-verifactu-trace-heading">Trazabilidad VeriFactu</h3><p className="muted">Estado operativo derivado del registro fiscal, la cola y el último intento.</p></div>{canViewVerifactuOperations ? <Link className="button button-secondary button-small" href={`/app/verifactu/operations?search=${encodeURIComponent(invoice.number ?? "")}`}>Ver operación</Link> : null}</div>
            <div className="data-grid"><div><span className="data-label">Estado operativo</span><strong>{verifactuOperationalStatusLabel(invoice.verifactuTrace.operationalStatus)}</strong></div><div><span className="data-label">Instalación</span><strong>{invoice.verifactuTrace.installationCode} · {invoice.verifactuTrace.environment}</strong></div><div><span className="data-label">Registro</span><strong>{invoice.verifactuTrace.recordType} · posición {invoice.verifactuTrace.chainPosition}</strong></div><div><span className="data-label">Preparado</span><strong>{formatDateTime(invoice.verifactuTrace.generatedAt)}</strong></div>{invoice.verifactuTrace.queue ? <><div><span className="data-label">Cola</span><strong>{invoice.verifactuTrace.queue.operation} · {invoice.verifactuTrace.queue.status}</strong><small>{invoice.verifactuTrace.queue.attemptCount} / {invoice.verifactuTrace.queue.maxAttempts} intentos</small></div><div><span className="data-label">Último error</span><strong>{invoice.verifactuTrace.queue.lastErrorCode ?? "Sin error"}</strong></div></> : null}{invoice.verifactuTrace.latestAttempt ? <div><span className="data-label">Último resultado</span><strong>{invoice.verifactuTrace.latestAttempt.outcome}</strong><small>{invoice.verifactuTrace.latestAttempt.stableErrorCode ?? "Sin código"}</small></div> : null}</div>
          </section> : null}
          {canRequestVerifactuCancellation
            && invoice.number
            && invoice.status === "ISSUED"
            && invoice.verifactuTrace?.recordType === "ALTA"
            && invoice.verifactuTrace.operationalStatus === "COMPLETED"
            && (invoice.verifactuStatus === "ACCEPTED" || invoice.verifactuStatus === "ACCEPTED_WITH_ERRORS")
            ? <VerifactuCancellationForm invoiceId={invoice.id} invoiceNumber={invoice.number} environment={invoice.verifactuTrace.environment} />
            : null}
          {invoice.verifactuStatus === "CANCELLED" ? (
            <section className="credential-installation stack" aria-labelledby="invoice-technical-voiding-heading">
              <div>
                <h3 id="invoice-technical-voiding-heading">Anulacion tecnica y regularizacion</h3>
                <p className="muted">La ANULACION AEAT esta completa. El documento comercial y la contabilidad se regularizan por separado, sin borrar la trazabilidad fiscal.</p>
              </div>
              <div className="data-grid">
                <div><span className="data-label">Fiscal</span><strong>Anulacion AEAT aceptada</strong></div>
                <div><span className="data-label">Comercial</span><strong>{invoice.status === "VOIDED" ? "Anulacion tecnica finalizada" : "Pendiente de regularizacion"}</strong></div>
                <div><span className="data-label">Tesoreria</span><strong>{invoice.payments.length === 0 && invoice.paymentReturns.length === 0 ? "Sin actividad financiera" : "Tiene cobros o devoluciones"}</strong></div>
                <div><span className="data-label">Contabilidad</span><strong>{invoice.voidingAccountingEntry ? (canViewAccounting ? `Contraasiento ${invoice.voidingAccountingEntry.number}` : "Contraasiento creado") : "Contraasiento pendiente"}</strong></div>
              </div>
              {canViewAccounting && invoice.voidingAccountingEntry ? (
                <Link className="button button-secondary button-small" href={`/app/accounting?entryId=${invoice.voidingAccountingEntry.id}`}>Ver contraasiento</Link>
              ) : null}
              {!canFinalizeVerifactuCancellation && invoice.status === "ISSUED" ? (
                <p className="message warning">No tienes el permiso específico para finalizar esta regularizacion.</p>
              ) : canFinalizeVerifactuCancellation && technicalVoidingEligible && invoice.number ? (
                <InvoiceTechnicalVoidingForm invoiceId={invoice.id} invoiceNumber={invoice.number} defaultVoidDate={invoice.issueDate} />
              ) : invoice.status === "ISSUED" ? (
                <p className="message warning">Esta factura no cumple las condiciones de anulacion tecnica: el motivo debe ser emision por error, la evidencia AEAT debe ser terminal y no puede haber cobros, remesas, vencimientos alterados ni rectificativas. La regularizacion alternativa permanece bloqueada hasta disponer del ALTA rectificativa VeriFactu real; requiere revision operativa.</p>
              ) : null}
            </section>
          ) : null}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Cobro</th>
                  <th>Fecha</th>
                  <th>Importe</th>
                  <th>Devuelto</th>
                  <th>Neto</th>
                  <th>Origen</th>
                  <th>Referencia</th>
                  <th>Asiento</th>
                </tr>
              </thead>
              <tbody>
                {invoice.payments.length === 0 ? (
                  <tr>
                    <td colSpan={8}>No hay cobros registrados.</td>
                  </tr>
                ) : (
                  invoice.payments.map((payment, index) => (
                    <tr key={payment.id}>
                      <td>
                        <strong>Cobro {index + 1}</strong>
                        <span className="cell-detail">
                          Vencimiento {dueDatePosition(invoice, payment.dueDateId)}
                        </span>
                      </td>
                      <td>{formatDate(payment.paymentDate)}</td>
                      <td>{formatMoney(payment.amount)}</td>
                      <td>{formatMoney(payment.returnedAmount)}</td>
                      <td>{formatMoney(payment.netAmount)}</td>
                      <td>{paymentSourceLabel(payment.source)}</td>
                      <td>{payment.reference ?? "Sin referencia"}</td>
                      <td>
                        {payment.accountingEntry ? (
                          canViewAccounting ? (
                            <Link href={`/app/accounting?entryId=${payment.accountingEntry.id}`}>
                              {payment.accountingEntry.number}
                            </Link>
                          ) : "Restringido"
                        ) : "Pendiente"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Devolucion</th>
                  <th>Fecha</th>
                  <th>Importe</th>
                  <th>Motivo</th>
                  <th>Asiento</th>
                </tr>
              </thead>
              <tbody>
                {invoice.paymentReturns.length === 0 ? (
                  <tr>
                    <td colSpan={5}>No hay devoluciones registradas.</td>
                  </tr>
                ) : (
                  invoice.paymentReturns.map((paymentReturn, index) => (
                    <tr key={paymentReturn.id}>
                      <td>
                        <strong>Devolucion {index + 1}</strong>
                        <span className="cell-detail">
                          Vencimiento {dueDatePosition(invoice, paymentReturn.dueDateId)}
                        </span>
                      </td>
                      <td>{formatDate(paymentReturn.returnDate)}</td>
                      <td>{formatMoney(paymentReturn.amount)}</td>
                      <td>{paymentReturn.reasonCode ?? "Sin motivo"}</td>
                      <td>
                        {paymentReturn.accountingEntry ? (
                          canViewAccounting ? (
                            <Link href={`/app/accounting?entryId=${paymentReturn.accountingEntry.id}`}>
                              {paymentReturn.accountingEntry.number}
                            </Link>
                          ) : "Restringido"
                        ) : "Pendiente"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel stack">
          <div>
            <h2>Resumen fiscal y cobro</h2>
            <p className="muted">
              Bases, IVA y vencimientos calculados desde las lineas del borrador.
            </p>
          </div>
          <div className="data-grid">
            <div>
              <span className="data-label">Base imponible</span>
              <strong>{formatMoney(invoice.totals.taxableBase)}</strong>
            </div>
            <div>
              <span className="data-label">IVA</span>
              <strong>{formatMoney(invoice.totals.taxAmount)}</strong>
            </div>
            <div>
              <span className="data-label">VeriFactu</span>
              <strong>{verifactuStatusLabel(invoice.verifactuStatus)}</strong>
            </div>
            <div>
              <span className="data-label">Cobro</span>
              <strong>{paymentStatusLabel(invoice.paymentStatus)}</strong>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>IVA</th>
                  <th>Base</th>
                  <th>Cuota</th>
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {invoice.taxSummary.length === 0 ? (
                  <tr>
                    <td colSpan={4}>Sin resumen fiscal hasta agregar lineas.</td>
                  </tr>
                ) : (
                  invoice.taxSummary.map((summary) => (
                    <tr key={`${summary.taxRateCode}-${summary.taxRate}`}>
                      <td>
                        <strong>{summary.taxRateCode}</strong>
                        <span className="cell-detail">{summary.taxRate}%</span>
                      </td>
                      <td>{formatMoney(summary.taxableBase)}</td>
                      <td>{formatMoney(summary.taxAmount)}</td>
                      <td>{formatMoney(summary.total)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Vencimiento</th>
                  <th>Importe</th>
                  <th>Cobrado</th>
                  <th>Compensado</th>
                  <th>Pendiente</th>
                  <th>Metodo</th>
                  <th>Estado</th>
                  <th>Remesa</th>
                </tr>
              </thead>
              <tbody>
                {invoice.dueDates.map((dueDate) => (
                  <tr key={dueDate.id}>
                    <td>{formatDate(dueDate.dueDate)}</td>
                    <td>{formatMoney(dueDate.amount)}</td>
                    <td>{formatMoney(dueDate.paidAmount)}</td>
                    <td>{formatMoney(dueDate.creditAppliedAmount)}</td>
                    <td>{formatMoney(dueDate.pendingAmount)}</td>
                    <td>{paymentMethodLabel(dueDate.paymentMethod)}</td>
                    <td>{dueDateStatusLabel(dueDate.status)}</td>
                    <td>
                      {dueDate.remittance ? (
                        canManagePayments ? (
                          <Link href={`/app/treasury/remittances/${dueDate.remittance.id}`}>
                            {dueDate.remittance.number}
                          </Link>
                        ) : "Restringida"
                      ) : dueDate.paymentMethod === "DIRECT_DEBIT" ? "Disponible" : "No aplica"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {canManageDrafts && editable ? (
          <div className="panel stack">
            <InvoiceLineCreateForm
              invoiceId={invoice.id}
              items={items.items}
              taxRates={taxRates}
            />
          </div>
        ) : null}

        {canManageDrafts && editable && invoice.documentType === "STANDARD" ? (
          <div className="panel stack">
            <InvoiceDueDatesForm
              invoiceId={invoice.id}
              total={invoice.totals.total}
              initialDueDates={invoice.dueDates.map((dueDate) => ({
                dueDate: dueDate.dueDate,
                amount: dueDate.amount,
                paymentMethod: dueDate.paymentMethod
              }))}
            />
          </div>
        ) : null}

        {canIssue && editable ? (
          <div className="panel stack">
            <InvoiceIssueButton
              invoiceId={invoice.id}
              defaultIssueDate={invoice.issueDate}
              disabled={issueDisabled}
            />
          </div>
        ) : null}

        {canCreateRectification ? (
          <div className="panel stack">
            <InvoiceRectificationCreateForm
              invoiceId={invoice.id}
              defaultIssueDate={invoice.issueDate}
            />
          </div>
        ) : null}

        {canManagePayments && invoice.status === "ISSUED" && invoice.verifactuStatus !== "CANCELLED" ? (
          <div className="panel stack">
            <CustomerPaymentRegisterForm
              invoiceId={invoice.id}
              dueDates={invoice.dueDates}
            />
            <CustomerDueDateUnpaidForm
              invoiceId={invoice.id}
              dueDates={invoice.dueDates}
            />
          </div>
        ) : null}
        {canManagePayments && (invoice.status === "ISSUED" || invoice.status === "RECTIFIED") && invoice.payments.length > 0 ? (
          <div className="panel stack">
            <CustomerPaymentReturnRegisterForm invoiceId={invoice.id} payments={invoice.payments} />
          </div>
        ) : null}
      </section>
    </main>
  );
}

function renderStatus(status: InvoiceDetail["status"]) {
  return (
    <span className="status">
      <span className={`status-dot status-dot-${status.toLowerCase()}`} />
      {invoiceStatusLabel(status)}
    </span>
  );
}

function invoiceStatusLabel(status: InvoiceDetail["status"]): string {
  switch (status) {
    case "DRAFT":
      return "Borrador";
    case "ISSUED":
      return "Emitida";
    case "RECTIFIED":
      return "Rectificada";
    case "VOIDED":
      return "Anulada";
  }
}

function documentTypeLabel(documentType: InvoiceDetail["documentType"]): string {
  switch (documentType) {
    case "STANDARD":
      return "Factura";
    case "RECTIFICATION":
      return "Factura rectificativa";
  }
}

function rectificationReasonLabel(reason: NonNullable<InvoiceDetail["rectificationReason"]>): string {
  switch (reason) {
    case "DATA_ERROR":
      return "Error en datos";
    case "AMOUNT_ERROR":
      return "Error en importes";
    case "RETURN":
      return "Devolucion";
    case "LATE_DISCOUNT":
      return "Descuento posterior";
    case "OPERATION_CANCELLED":
      return "Anulacion de operacion";
    case "UNPAID":
      return "Impago";
    case "OTHER":
      return "Otro";
    default:
      return reason;
  }
}

function paymentMethodLabel(
  method: InvoiceDetail["dueDates"][number]["paymentMethod"]
): string {
  switch (method) {
    case "BANK_TRANSFER":
      return "Transferencia";
    case "CASH":
      return "Contado";
    case "DIRECT_DEBIT":
      return "Domiciliacion";
  }
}

function dueDateStatusLabel(status: InvoiceDetail["dueDates"][number]["status"]): string {
  switch (status) {
    case "PENDING":
      return "Pendiente";
    case "PAID":
      return "Pagado";
    case "SETTLED":
      return "Compensado";
    case "RETURNED":
      return "Devuelto";
    case "UNPAID":
      return "Impagado";
    case "CANCELLED":
      return "Cancelado";
  }
}

function paymentStatusLabel(status: InvoiceDetail["paymentStatus"]): string {
  switch (status) {
    case "PENDING":
      return "Pendiente";
    case "PARTIALLY_PAID":
      return "Parcialmente cobrada";
    case "PAID":
      return "Cobrada";
    case "PARTIALLY_SETTLED":
      return "Parcialmente compensada";
    case "SETTLED":
      return "Compensada";
    case "NOT_APPLICABLE":
      return "No sujeta a cobro (abono)";
    case "UNPAID":
      return "Impagada";
    case "CANCELLED":
      return "Cancelada";
  }
}

function paymentSourceLabel(source: InvoiceDetail["payments"][number]["source"]): string {
  switch (source) {
    case "MANUAL":
      return "Manual";
    case "SEPA_REMITTANCE":
      return "Remesa SEPA";
  }
}

function dueDatePosition(
  invoice: InvoiceDetail,
  dueDateId: string
): number | string {
  return invoice.dueDates.find((dueDate) => dueDate.id === dueDateId)?.position ?? "-";
}

function verifactuStatusLabel(status: InvoiceDetail["verifactuStatus"]): string {
  switch (status) {
    case "NOT_APPLICABLE":
      return "No aplica";
    case "PENDING":
      return "Pendiente";
    case "SENT":
      return "Enviada";
    case "ACCEPTED":
      return "Aceptada";
    case "ACCEPTED_WITH_ERRORS":
      return "Aceptada con errores";
    case "REJECTED":
      return "Rechazada";
    case "CANCELLED":
      return "Anulada en AEAT";
  }
}

function verifactuOperationalStatusLabel(status: NonNullable<InvoiceDetail["verifactuTrace"]>["operationalStatus"]): string {
  return status === "ACTION_REQUIRED" ? "Requiere intervención"
    : status === "RECONCILIATION_REQUIRED" ? "Conciliación pendiente"
      : status === "PROCESSING" ? "Procesando"
        : status === "PENDING" ? "Pendiente de envío"
          : "Completado";
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("es-ES");
}

function formatDate(value: string): string {
  return new Date(`${value}T00:00:00.000Z`).toLocaleDateString("es-ES");
}

function formatMoney(value: string): string {
  return `${value} EUR`;
}
