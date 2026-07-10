import Link from "next/link";
import { z } from "zod";
import {
  getCustomerRemittance,
  type CustomerRemittanceDto
} from "@/modules/treasury/application/remittances";
import { CustomerRemittanceCancelButton } from "@/modules/treasury/presentation/CustomerRemittanceCancelButton";
import { CustomerRemittanceCloseButton } from "@/modules/treasury/presentation/CustomerRemittanceCloseButton";
import { CustomerRemittanceProcessForm } from "@/modules/treasury/presentation/CustomerRemittanceProcessForm";
import { authorizePagePermission } from "@/modules/platform/presentation/pageAccess";

export const dynamic = "force-dynamic";

type TreasuryRemittanceDetailPageProps = {
  params: Promise<{
    remittanceId: string;
  }>;
};

const paramsSchema = z.object({
  remittanceId: z.string().uuid()
});

export default async function TreasuryRemittanceDetailPage({
  params
}: TreasuryRemittanceDetailPageProps) {
  const authorization = await authorizePagePermission("Treasury.ManagePayments");
  const parsedParams = paramsSchema.safeParse(await params);

  if (!authorization.ok) {
    return shellMessage("Remesa", authorization.message);
  }

  if (!parsedParams.success) {
    return shellMessage("Remesa", "Identificador de remesa invalido.");
  }

  const remittance = await getCustomerRemittance(
    parsedParams.data.remittanceId,
    authorization.user
  );

  if (!remittance) {
    return shellMessage("Remesa", "La remesa no existe.");
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">CriGestión</div>
        <div className="button-row">
          <Link className="button button-secondary" href="/app/treasury/remittances">
            Remesas
          </Link>
          <Link className="button button-secondary" href="/app/treasury">
            Vencimientos
          </Link>
        </div>
      </header>
      <section className="content stack">
        <div className="panel stack">
          <div className="split-header">
            <div>
              <h1>{remittance.number}</h1>
              <p className="muted">{remittance.concept}</p>
            </div>
            {renderStatus(remittance.status)}
          </div>

          <div className="data-grid">
            <div>
              <span className="data-label">Fecha de cargo</span>
              <strong>{formatDate(remittance.chargeDate)}</strong>
            </div>
            <div>
              <span className="data-label">Ejercicio</span>
              <strong>{remittance.year}</strong>
            </div>
            <div>
              <span className="data-label">Lineas</span>
              <strong>{remittance.lineCount}</strong>
            </div>
            <div>
              <span className="data-label">Total</span>
              <strong>{formatMoney(remittance.totalAmount)}</strong>
            </div>
          </div>

          {remittance.status === "DRAFT" ? (
            <div className="button-row">
              <CustomerRemittanceProcessForm
                remittanceId={remittance.id}
                defaultPaymentDate={remittance.chargeDate}
              />
              <CustomerRemittanceCancelButton remittanceId={remittance.id} />
            </div>
          ) : null}

          {remittance.status === "PROCESSED" ||
          remittance.status === "PARTIALLY_RETURNED" ? (
            <div className="button-row">
              <CustomerRemittanceCloseButton remittanceId={remittance.id} />
            </div>
          ) : null}
        </div>

        <div className="panel stack">
          <div>
            <h2>Lineas de remesa</h2>
            <p className="muted">
              Vencimientos incluidos sin exponer IBAN ni datos bancarios completos.
            </p>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Linea</th>
                  <th>Cliente</th>
                  <th>Factura</th>
                  <th>Vencimiento</th>
                  <th>Importes</th>
                  <th>Concepto</th>
                  <th>Mandato</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {remittance.lines.map((line) => (
                  <tr key={line.id}>
                    <td>{line.position}</td>
                    <td>
                      <strong>{line.customer.legalName}</strong>
                      <span className="cell-detail">{line.customer.code}</span>
                    </td>
                    <td>{line.invoiceNumber ?? "Sin numero"}</td>
                    <td>{formatDate(line.dueDate)}</td>
                    <td>
                      <strong>{formatMoney(line.netAmount)}</strong>
                      <span className="cell-detail">
                        Remesado {formatMoney(line.amount)}
                      </span>
                      <span className="cell-detail">
                        Cobrado {formatMoney(line.paymentAmount)}
                      </span>
                      {Number(line.returnedAmount) > 0 ? (
                        <span className="cell-detail">
                          Devuelto {formatMoney(line.returnedAmount)}
                        </span>
                      ) : null}
                    </td>
                    <td>{line.concept}</td>
                    <td>{line.mandateReference}</td>
                    <td>
                      <Link
                        className="button button-secondary button-small"
                        href={`/app/invoices/${line.invoiceId}`}
                      >
                        Abrir factura
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </main>
  );
}

function shellMessage(title: string, message: string) {
  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">CriGestión</div>
        <Link className="button button-secondary" href="/app/treasury/remittances">
          Volver
        </Link>
      </header>
      <section className="content">
        <div className="panel stack">
          <h1>{title}</h1>
          <p className="message error">{message}</p>
        </div>
      </section>
    </main>
  );
}

function renderStatus(status: CustomerRemittanceDto["status"]) {
  return (
    <span className="status">
      <span className={`status-dot status-dot-${status.toLowerCase()}`} />
      {remittanceStatusLabel(status)}
    </span>
  );
}

function remittanceStatusLabel(status: CustomerRemittanceDto["status"]): string {
  switch (status) {
    case "DRAFT":
      return "Borrador";
    case "GENERATED":
      return "Generada";
    case "SENT":
      return "Enviada";
    case "PROCESSED":
      return "Procesada";
    case "PARTIALLY_RETURNED":
      return "Parcialmente devuelta";
    case "CLOSED":
      return "Cerrada";
    case "CANCELLED":
      return "Cancelada";
  }
}

function formatMoney(value: string): string {
  return new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: "EUR"
  }).format(Number(value));
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("es-ES").format(new Date(`${value}T00:00:00.000Z`));
}
