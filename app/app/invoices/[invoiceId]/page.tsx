import Link from "next/link";
import { z } from "zod";
import {
  getInvoiceDetail,
  type InvoiceDetail
} from "@/modules/billing/application/invoices";
import { InvoiceIssueButton } from "@/modules/billing/presentation/InvoiceIssueButton";
import { InvoiceLineCreateForm } from "@/modules/billing/presentation/InvoiceLineCreateForm";
import { InvoiceRectificationCreateForm } from "@/modules/billing/presentation/InvoiceRectificationCreateForm";
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
    invoice.rectificationInvoices.length === 0;

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
                </tr>
              </thead>
              <tbody>
                {invoice.payments.length === 0 ? (
                  <tr>
                    <td colSpan={7}>No hay cobros registrados.</td>
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
                </tr>
              </thead>
              <tbody>
                {invoice.paymentReturns.length === 0 ? (
                  <tr>
                    <td colSpan={4}>No hay devoluciones registradas.</td>
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
                  <th>Pendiente</th>
                  <th>Metodo</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {invoice.dueDates.map((dueDate) => (
                  <tr key={dueDate.id}>
                    <td>{formatDate(dueDate.dueDate)}</td>
                    <td>{formatMoney(dueDate.amount)}</td>
                    <td>{formatMoney(dueDate.paidAmount)}</td>
                    <td>{formatMoney(dueDate.pendingAmount)}</td>
                    <td>{paymentMethodLabel(dueDate.paymentMethod)}</td>
                    <td>{dueDateStatusLabel(dueDate.status)}</td>
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

        {canManagePayments && invoice.status === "ISSUED" ? (
          <div className="panel stack">
            <CustomerPaymentRegisterForm
              invoiceId={invoice.id}
              dueDates={invoice.dueDates}
            />
            <CustomerPaymentReturnRegisterForm
              invoiceId={invoice.id}
              payments={invoice.payments}
            />
            <CustomerDueDateUnpaidForm
              invoiceId={invoice.id}
              dueDates={invoice.dueDates}
            />
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
    case "RETURNED":
      return "Devuelto";
    case "UNPAID":
      return "Impagado";
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
    case "UNPAID":
      return "Impagada";
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
  }
}

function formatDate(value: string): string {
  return new Date(`${value}T00:00:00.000Z`).toLocaleDateString("es-ES");
}

function formatMoney(value: string): string {
  return `${value} EUR`;
}
