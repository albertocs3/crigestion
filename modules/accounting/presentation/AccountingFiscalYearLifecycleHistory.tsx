import Link from "next/link";
import type { FiscalYearLifecycleHistoryItem } from "@/modules/accounting/application/fiscalYearLifecycleHistory";

export function AccountingFiscalYearLifecycleHistory({
  items
}: {
  items: FiscalYearLifecycleHistoryItem[];
}) {
  return <div className="panel stack">
    <div>
      <h2>Historial de cierres y reaperturas</h2>
      <p className="muted">Evidencia completa por ciclo, incluidos rechazos, caducidades y contraasientos.</p>
    </div>
    {items.length === 0 ? <p>No hay ciclos de cierre registrados.</p> : <div className="table-wrap"><table>
      <thead><tr><th>Ejercicio</th><th>Tramite</th><th>Solicitud</th><th>Resolucion</th><th>Evidencia</th></tr></thead>
      <tbody>{items.flatMap((item) => {
        const close = item.closeRequest;
        const closeRow = <tr key={`close-${close.id}`}>
          <td><strong>{close.year}</strong>{close.successorYear ? ` → ${close.successorYear}` : ""}</td>
          <td>Cierre · {statusLabel(close.status)}</td>
          <td>{close.requestedByName}<br/><span className="muted">{formatDate(close.requestedAt)}</span></td>
          <td>{close.terminalByName ?? "Pendiente"}{close.terminalAt ? <><br/><span className="muted">{formatDate(close.terminalAt)}</span></> : null}</td>
          <td><EntryLinks entries={close.entries} year={close.year} /></td>
        </tr>;
        const reopenRows = item.reopenRequests.map((reopen) => <tr key={`reopen-${reopen.id}`}>
          <td>{close.year}</td>
          <td>Reapertura · {statusLabel(reopen.status)}<br/><span className="muted">{reopen.reason}</span>{reopen.rejectionReason ? <><br/><span>Rechazo: {reopen.rejectionReason}</span></> : null}</td>
          <td>{reopen.requestedByName}<br/><span className="muted">{formatDate(reopen.requestedAt)} · caduca {formatDate(reopen.expiresAt)}</span></td>
          <td>{reopen.terminalByName ?? "Pendiente"}{reopen.terminalAt ? <><br/><span className="muted">{formatDate(reopen.terminalAt)}</span></> : null}</td>
          <td><EntryLinks entries={reopen.reversalEntries} year={close.year} /></td>
        </tr>);
        return [closeRow, ...reopenRows];
      })}</tbody>
    </table></div>}
  </div>;
}

function EntryLinks({ entries, year }: { entries: Array<{ id: string; number: string; label: string }>; year: number }) {
  if (entries.length === 0) return <>-</>;
  return <>{entries.map((entry, index) => <span key={entry.id}>
    {index > 0 ? ", " : null}<Link href={`/app/accounting?year=${year}&entryId=${entry.id}`}>{entry.label} {entry.number}</Link>
  </span>)}</>;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString("es-ES");
}

function statusLabel(status: string): string {
  return {
    REQUESTED: "Pendiente",
    COMPLETED: "Completado",
    CANCELLED: "Cancelado",
    REJECTED: "Rechazado",
    EXPIRED: "Caducado"
  }[status] ?? status;
}
