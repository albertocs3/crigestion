import Link from "next/link";
import { z } from "zod";
import { listBankAccounts } from "@/modules/treasury/application/banking";
import {
  getCustomerCredit,
  listCustomerCredits,
  listCustomerCreditsSchema,
  type CustomerCreditDetail,
  type CustomerCreditStatus
} from "@/modules/treasury/application/customerCredits";
import {
  CustomerCreditApplicationForm,
  CustomerCreditRefundActionButton,
  CustomerCreditRefundRequestForm
} from "@/modules/treasury/presentation/CustomerCreditForms";
import { authorizePagePermission } from "@/modules/platform/presentation/pageAccess";

export const dynamic = "force-dynamic";

type CreditsPageProps = {
  searchParams: Promise<{ cursor?: string; status?: string; customerId?: string; search?: string; creditId?: string }>;
};

const selectedCreditSchema = z.string().uuid();

export default async function CustomerCreditsPage({ searchParams }: CreditsPageProps) {
  const authorization = await authorizePagePermission("Treasury.ViewCustomerCredits");
  const params = await searchParams;
  if (!authorization.ok) return unauthorized(authorization.message);

  const query = listCustomerCreditsSchema.safeParse({ limit: 25, cursor: params.cursor, status: params.status, customerId: params.customerId, search: params.search });
  const creditList = query.success ? await listCustomerCredits(query.data, authorization.user) : emptyList();
  const selectedId = selectedCreditSchema.safeParse(params.creditId);
  const selectedCredit = selectedId.success ? await getCustomerCredit(selectedId.data) : null;
  const permissions = authorization.user.permissions;
  const canApply = permissions.includes("Treasury.ApplyCustomerCredits");
  const canRequestRefund = permissions.includes("Treasury.RequestCustomerRefunds");
  const canApproveRefund = permissions.includes("Treasury.ApproveCustomerRefunds");
  const canPostRefund = permissions.includes("Treasury.PostCustomerRefunds");
  const canViewAccounting = permissions.includes("Accounting.View");
  const bankAccounts = canRequestRefund ? (await listBankAccounts(authorization.user)).bankAccounts : [];

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">CriGestión</div>
        <div className="button-row"><Link className="button button-secondary" href="/app/treasury">Tesoreria</Link><Link className="button button-secondary" href="/app">Inicio</Link></div>
      </header>
      <section className="content stack">
        <div className="panel stack">
          <div><p className="eyebrow">Tesoreria</p><h1>Saldos a favor de clientes</h1><p className="muted">Creditos originados por rectificativas, con compensaciones y reembolsos trazables.</p></div>
          <div className="data-grid">
            <div><span className="data-label">Creditos</span><strong>{creditList.summary.count}</strong></div>
            <div><span className="data-label">Original</span><strong>{formatMoney(creditList.summary.originalAmount)}</strong></div>
            <div><span className="data-label">Aplicado</span><strong>{formatMoney(creditList.summary.appliedAmount)}</strong></div>
            <div><span className="data-label">Reembolsado</span><strong>{formatMoney(creditList.summary.refundedAmount)}</strong></div>
            <div><span className="data-label">Disponible</span><strong>{formatMoney(creditList.summary.availableAmount)}</strong></div>
          </div>
          <form className="filter-row" action="/app/treasury/credits">
            {params.customerId ? <input type="hidden" name="customerId" value={params.customerId} /> : null}
            <label>Buscar<input name="search" maxLength={120} defaultValue={params.search ?? ""} placeholder="Cliente o rectificativa" /></label>
            <label>Estado<select name="status" defaultValue={params.status ?? "WITH_BALANCE"}><option value="WITH_BALANCE">Con saldo</option><option value="EXHAUSTED">Agotados</option><option value="ALL">Todos</option></select></label>
            <div className="form-actions"><button className="button" type="submit">Filtrar</button><Link className="button button-secondary" href="/app/treasury/credits">Limpiar</Link></div>
          </form>
          {!query.success ? <p className="message error" role="alert">Los filtros no son validos.</p> : null}
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Creditos de clientes y saldos disponibles</caption>
              <thead><tr><th scope="col">Origen</th><th scope="col">Cliente</th><th scope="col">Estado</th><th scope="col">Original</th><th scope="col">Aplicado</th><th scope="col">Reembolsado</th><th scope="col">Reservado</th><th scope="col">Disponible</th><th scope="col">Acciones</th></tr></thead>
              <tbody>
                {creditList.credits.map((credit) => <tr key={credit.id}>
                  <td><strong>{credit.sourceInvoice.number ?? "Rectificativa"}</strong><span className="cell-detail">{formatDate(credit.sourceInvoice.issueDate)}</span></td>
                  <td><strong>{credit.customer.legalName}</strong><span className="cell-detail">{credit.customer.code}</span></td>
                  <td>{creditStatusLabel(credit.status)}</td>
                  <td>{formatMoney(credit.originalAmount)}</td><td>{formatMoney(credit.appliedAmount)}</td><td>{formatMoney(credit.postedRefundAmount)}</td><td>{formatMoney(credit.reservedRefundAmount)}</td><td><strong>{formatMoney(credit.availableAmount)}</strong></td>
                  <td><Link className="button button-secondary button-small" href={detailHref(credit.id, params)}>Gestionar</Link></td>
                </tr>)}
              </tbody>
            </table>
          </div>
          {creditList.credits.length === 0 ? <p className="muted">{hasFilters(params) ? "No hay saldos que coincidan con los filtros." : "No hay saldos a favor registrados."}</p> : null}
          {creditList.nextCursor ? <Link className="button button-secondary" href={nextHref(creditList.nextCursor, params)}>Siguiente pagina</Link> : null}
        </div>

        {params.creditId && !selectedId.success ? <div className="panel"><p className="message error" role="alert">El identificador del credito no es valido.</p></div> : null}
        {selectedId.success && !selectedCredit ? <div className="panel"><p className="message error" role="alert">El credito no existe.</p></div> : null}
        {selectedCredit ? <CreditDetail
          credit={selectedCredit}
          currentUserId={authorization.user.id}
          canApply={canApply}
          canRequestRefund={canRequestRefund}
          canApproveRefund={canApproveRefund}
          canPostRefund={canPostRefund}
          canViewAccounting={canViewAccounting}
          bankAccounts={bankAccounts}
        /> : null}
      </section>
    </main>
  );
}

function CreditDetail({ credit, currentUserId, canApply, canRequestRefund, canApproveRefund, canPostRefund, canViewAccounting, bankAccounts }: {
  credit: CustomerCreditDetail; currentUserId: string; canApply: boolean; canRequestRefund: boolean; canApproveRefund: boolean; canPostRefund: boolean; canViewAccounting: boolean; bankAccounts: Awaited<ReturnType<typeof listBankAccounts>>["bankAccounts"];
}) {
  const hasAvailableBalance = Number(credit.availableAmount) > 0;
  return <>
    <div className="panel stack" id="credit-detail">
      <div className="split-header"><div><p className="eyebrow">Detalle del saldo</p><h2>{credit.customer.legalName}</h2><p className="muted">Origen <Link href={`/app/invoices/${credit.sourceInvoice.id}`}>{credit.sourceInvoice.number ?? "rectificativa"}</Link> · {credit.customer.code}</p></div><span className="status">{creditStatusLabel(credit.status)}</span></div>
      <div className="data-grid"><div><span className="data-label">Original</span><strong>{formatMoney(credit.originalAmount)}</strong></div><div><span className="data-label">Aplicado</span><strong>{formatMoney(credit.appliedAmount)}</strong></div><div><span className="data-label">Reembolsado</span><strong>{formatMoney(credit.postedRefundAmount)}</strong></div><div><span className="data-label">Reservado</span><strong>{formatMoney(credit.reservedRefundAmount)}</strong></div><div><span className="data-label">Disponible</span><strong>{formatMoney(credit.availableAmount)}</strong></div></div>
      <h3>Compensaciones</h3>
      <div className="table-wrap"><table><caption className="sr-only">Compensaciones realizadas con este saldo</caption><thead><tr><th scope="col">Fecha</th><th scope="col">Factura</th><th scope="col">Importe</th></tr></thead><tbody>{credit.applications.length === 0 ? <tr><td colSpan={3}>No hay compensaciones.</td></tr> : credit.applications.map((application) => <tr key={application.id}><td>{formatDate(application.applicationDate)}</td><td><Link href={`/app/invoices/${application.targetInvoice.id}`}>{application.targetInvoice.number ?? "Factura"}</Link></td><td>{formatMoney(application.amount)}</td></tr>)}</tbody></table></div>
      <h3>Reembolsos</h3>
      <div className="table-wrap"><table><caption className="sr-only">Solicitudes y reembolsos de este saldo</caption><thead><tr><th scope="col">Fecha</th><th scope="col">Importe</th><th scope="col">Cuenta</th><th scope="col">Motivo</th><th scope="col">Estado</th><th scope="col">Asiento</th><th scope="col">Acciones</th></tr></thead><tbody>{credit.refunds.length === 0 ? <tr><td colSpan={7}>No hay solicitudes de reembolso.</td></tr> : credit.refunds.map((refund) => <tr key={refund.id}><td>{formatDate(refund.requestedDate)}</td><td>{formatMoney(refund.amount)}</td><td>{refund.bankAccount.name}<span className="cell-detail">{refund.bankAccount.maskedIban}</span></td><td>{refundReasonLabel(refund.reasonCode)}</td><td>{refundStatusLabel(refund.status)}</td><td>{refund.accountingEntry ? canViewAccounting ? <Link href={`/app/accounting?entryId=${refund.accountingEntry.id}`}>{refund.accountingEntry.number}</Link> : "Creado" : "—"}</td><td><div className="button-row">{refund.status === "REQUESTED" && canApproveRefund && refund.requestedById !== currentUserId ? <CustomerCreditRefundActionButton refundId={refund.id} action="approve" /> : null}{refund.status === "REQUESTED" && canRequestRefund ? <CustomerCreditRefundActionButton refundId={refund.id} action="cancel" /> : null}{refund.status === "APPROVED" && canPostRefund ? <CustomerCreditRefundActionButton refundId={refund.id} action="post" /> : null}</div>{refund.status === "REQUESTED" && canApproveRefund && refund.requestedById === currentUserId ? <small>La persona solicitante no puede aprobar.</small> : null}</td></tr>)}</tbody></table></div>
    </div>
    {!hasAvailableBalance ? <div className="panel"><p className="message">El saldo esta agotado. El historial permanece disponible para consulta.</p></div> : null}
    {canApply && hasAvailableBalance ? <div className="panel stack"><CustomerCreditApplicationForm credit={credit} /></div> : null}
    {canRequestRefund && hasAvailableBalance ? <div className="panel stack"><CustomerCreditRefundRequestForm credit={credit} bankAccounts={bankAccounts} /></div> : null}
  </>;
}

function unauthorized(message: string) { return <main className="shell"><header className="topbar"><div className="brand">CriGestión</div><Link className="button button-secondary" href="/app">Volver</Link></header><section className="content"><div className="panel stack"><h1>Saldos a favor</h1><p className="message error" role="alert">{message}</p></div></section></main>; }
function emptyList() { return { credits: [], summary: { count: 0, originalAmount: "0.00", appliedAmount: "0.00", refundedAmount: "0.00", availableAmount: "0.00" }, nextCursor: null }; }
function creditStatusLabel(status: CustomerCreditStatus): string { return status === "HELD" ? "Retenido" : status === "AVAILABLE" ? "Disponible" : status === "PARTIALLY_USED" ? "Parcial" : "Agotado"; }
function refundStatusLabel(status: CustomerCreditDetail["refunds"][number]["status"]): string { return status === "REQUESTED" ? "Solicitado" : status === "APPROVED" ? "Aprobado" : status === "POSTED" ? "Contabilizado" : "Cancelado"; }
function refundReasonLabel(reason: string): string { return reason === "CUSTOMER_REQUEST" ? "Solicitud del cliente" : reason === "DUPLICATE_OR_EXCESS" ? "Duplicidad o exceso" : reason === "CANCELLATION" ? "Cancelacion" : "Otro"; }
function formatDate(value: string): string { return new Date(`${value}T00:00:00.000Z`).toLocaleDateString("es-ES"); }
function formatMoney(value: string): string { return `${value} EUR`; }
function hasFilters(params: CreditsPageProps["searchParams"] extends Promise<infer T> ? T : never): boolean { return Boolean(params.search || params.customerId || (params.status && params.status !== "WITH_BALANCE")); }
function detailHref(creditId: string, params: { status?: string; search?: string; customerId?: string }): string { const query = new URLSearchParams({ creditId }); if (params.status) query.set("status", params.status); if (params.search) query.set("search", params.search); if (params.customerId) query.set("customerId", params.customerId); return `/app/treasury/credits?${query.toString()}#credit-detail`; }
function nextHref(cursor: string, params: { status?: string; search?: string; customerId?: string }): string { const query = new URLSearchParams({ cursor }); if (params.status) query.set("status", params.status); if (params.search) query.set("search", params.search); if (params.customerId) query.set("customerId", params.customerId); return `/app/treasury/credits?${query.toString()}`; }
