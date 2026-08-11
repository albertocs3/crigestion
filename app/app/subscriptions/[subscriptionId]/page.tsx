import Link from "next/link";
import { notFound } from "next/navigation";
import { authorizePagePermission } from "@/modules/platform/presentation/pageAccess";
import { getSubscription, listSubscriptionReferences, subscriptionParamsSchema } from "@/modules/subscriptions/application/subscriptions";
import { subscriptionRenewalBusinessDate } from "@/modules/subscriptions/application/renewals";
import { SubscriptionActivateButton } from "@/modules/subscriptions/presentation/SubscriptionActivateButton";
import { SubscriptionCancelForm } from "@/modules/subscriptions/presentation/SubscriptionCancelForm";
import { SubscriptionCancellationScheduleForms } from "@/modules/subscriptions/presentation/SubscriptionCancellationScheduleForms";
import { SubscriptionChangeScheduleForms } from "@/modules/subscriptions/presentation/SubscriptionChangeScheduleForms";
import { SubscriptionEditForm } from "@/modules/subscriptions/presentation/SubscriptionEditForm";
import { SubscriptionReactivateForm } from "@/modules/subscriptions/presentation/SubscriptionReactivateForm";
import { SubscriptionReactivationScheduleForms } from "@/modules/subscriptions/presentation/SubscriptionReactivationScheduleForms";

export const dynamic = "force-dynamic";

export default async function SubscriptionDetailPage({ params }: { params: Promise<{ subscriptionId: string }> }) {
  const authorization = await authorizePagePermission("Subscriptions.View");
  if (!authorization.ok) return <main className="shell"><section className="content"><div className="panel"><p className="message error">{authorization.message}</p></div></section></main>;
  const parsed = subscriptionParamsSchema.safeParse(await params);
  if (!parsed.success) notFound();
  const subscription = await getSubscription(parsed.data.subscriptionId, authorization.user);
  if (!subscription) notFound();
  const canManage = authorization.user.permissions.includes("Subscriptions.Manage");
  const canManageEconomics = authorization.user.permissions.includes("Subscriptions.ManageEconomics");
  const canCancel = authorization.user.permissions.includes("Subscriptions.Cancel");
  const canReactivate = authorization.user.permissions.includes("Subscriptions.Reactivate");
  const canScheduleReactivations = authorization.user.permissions.includes("Subscriptions.ScheduleReactivations");
  const canScheduleChanges = authorization.user.permissions.includes("Subscriptions.ScheduleChanges") && canManageEconomics;
  const references = canManage && subscription.status === "DRAFT" ? await listSubscriptionReferences() : null;
  const pendingSchedule = subscription.cancellationSchedules.find((schedule) => schedule.status === "PENDING") ?? null;
  const pendingReactivationSchedule = subscription.reactivationSchedules.find((schedule) => schedule.status === "PENDING") ?? null;
  const pendingChangeSchedule = subscription.changeSchedules.find((schedule) => schedule.status === "PENDING") ?? null;
  const businessDate = (canReactivate || canScheduleReactivations) && subscription.status === "CANCELLED" ? await subscriptionRenewalBusinessDate() : null;
  const minimumReactivationDate = maxDateOnly(subscription.cancellation ? nextDate(subscription.cancellation.effectiveDate) : subscription.nextRenewalDate, businessDate);
  const defaultReactivationDate = subscription.nextRenewalDate < minimumReactivationDate ? minimumReactivationDate : subscription.nextRenewalDate;
  const reactivationDateAvailable = !subscription.endDate || subscription.endDate >= minimumReactivationDate;
  const minimumScheduledReactivationDate = maxDateOnly(subscription.cancellation ? nextDate(subscription.cancellation.effectiveDate) : subscription.nextRenewalDate, businessDate ? nextDate(businessDate) : null);
  const defaultScheduledRenewalDate = subscription.nextRenewalDate < minimumScheduledReactivationDate ? minimumScheduledReactivationDate : subscription.nextRenewalDate;
  const scheduledReactivationDateAvailable = !subscription.endDate || subscription.endDate >= minimumScheduledReactivationDate;
  return <main className="shell">
    <header className="topbar"><div className="brand">CriGestión</div><Link className="button button-secondary" href="/app/subscriptions">Volver</Link></header>
    <section className="content stack">
      <div className="panel stack"><div><h1>{subscription.number}</h1><p className="muted">{subscription.name}</p></div>
        <dl className="detail-grid"><div><dt>Cliente</dt><dd>{subscription.customer.code} - {subscription.customer.legalName}</dd></div><div><dt>Estado</dt><dd>{subscription.status}</dd></div><div><dt>Periodicidad</dt><dd>{subscription.periodicity}</dd></div><div><dt>Modalidad</dt><dd>{subscription.pricingMode}</dd></div><div><dt>Inicio</dt><dd>{subscription.startDate}</dd></div><div><dt>Proxima renovacion</dt><dd>{subscription.nextRenewalDate}</dd></div><div><dt>Forma de pago</dt><dd>{subscription.paymentMethod}</dd></div><div><dt>Total estimado</dt><dd>{subscription.estimatedTotal} EUR</dd></div></dl>
        {subscription.notes ? <p>{subscription.notes}</p> : null}
        {canManage && subscription.status === "DRAFT" ? <SubscriptionActivateButton subscriptionId={subscription.id} version={subscription.version} /> : null}
        {subscription.cancellation ? <p className="message">Cancelada con fecha {subscription.cancellation.effectiveDate} ({subscription.cancellation.mode === "SCHEDULED" ? "baja programada" : "baja inmediata"}). Motivo: {subscription.cancellation.reason}</p> : null}
      </div>
      <div className="panel stack"><h2>Conceptos contratados</h2><div className="table-wrap"><table><thead><tr><th>Concepto</th><th>Cantidad</th><th>Precio</th><th>Descuento</th><th>IVA</th><th>Total</th></tr></thead><tbody>{subscription.lines.map((line) => <tr key={line.id}><td><strong>{line.description}</strong><span className="cell-detail">{line.catalogItemCode}</span></td><td>{line.quantity}</td><td>{line.unitPrice} EUR</td><td>{line.discountPercent}% + {line.discountAmount} EUR</td><td>{line.taxRate}%</td><td>{line.total} EUR</td></tr>)}</tbody></table></div></div>
      {references ? <div className="panel stack"><SubscriptionEditForm subscription={subscription} references={references} canManageEconomics={canManageEconomics} /></div> : null}
      {canReactivate && subscription.status === "CANCELLED" && !pendingReactivationSchedule && reactivationDateAvailable ? <div className="panel stack"><SubscriptionReactivateForm subscriptionId={subscription.id} version={subscription.version} defaultNextRenewalDate={defaultReactivationDate} minimumNextRenewalDate={minimumReactivationDate} maximumNextRenewalDate={subscription.endDate} /></div> : null}
      {canReactivate && subscription.status === "CANCELLED" && !pendingReactivationSchedule && !reactivationDateAvailable ? <div className="panel stack"><h2>Reactivar ahora</h2><p className="message warning">No se puede reactivar porque la fecha final del contrato es anterior a la primera fecha de renovacion permitida.</p></div> : null}
      {canScheduleReactivations && subscription.status === "CANCELLED" && (pendingReactivationSchedule || scheduledReactivationDateAvailable) ? <div className="panel stack"><SubscriptionReactivationScheduleForms subscriptionId={subscription.id} subscriptionVersion={subscription.version} businessDate={businessDate!} minimumEffectiveDate={minimumScheduledReactivationDate} maximumEffectiveDate={subscription.endDate} defaultNextRenewalDate={defaultScheduledRenewalDate} pendingSchedule={pendingReactivationSchedule} /></div> : null}
      {canScheduleReactivations && subscription.status === "CANCELLED" && !pendingReactivationSchedule && !scheduledReactivationDateAvailable ? <div className="panel stack"><h2>Programar reactivacion</h2><p className="message warning">No se puede programar porque la fecha final del contrato es anterior a la primera fecha efectiva permitida.</p></div> : null}
      {canScheduleChanges && subscription.status === "ACTIVE" && subscription.pricingMode === "PER_LICENSE" && (pendingChangeSchedule || !pendingSchedule) ? <div className="panel stack"><SubscriptionChangeScheduleForms subscriptionId={subscription.id} subscriptionVersion={subscription.version} nextRenewalDate={subscription.nextRenewalDate} lines={subscription.lines.map(({ id, position, description, quantity }) => ({ id, position, description, quantity }))} pendingSchedule={pendingChangeSchedule} /></div> : null}
      {canCancel && !pendingChangeSchedule && (subscription.status === "ACTIVE" || subscription.status === "RENEWAL_PENDING") ? <div className="panel stack"><SubscriptionCancelForm subscriptionId={subscription.id} version={subscription.version} /></div> : null}
      {canCancel && !pendingChangeSchedule && (subscription.status === "ACTIVE" || subscription.status === "RENEWAL_PENDING") ? <div className="panel stack"><SubscriptionCancellationScheduleForms subscriptionId={subscription.id} subscriptionVersion={subscription.version} nextRenewalDate={subscription.nextRenewalDate} pendingSchedule={pendingSchedule} /></div> : null}
      {subscription.reactivations.length ? <div className="panel stack"><h2>Historial de reactivaciones</h2><div className="table-wrap"><table><thead><tr><th>Reactivada</th><th>Fecha efectiva</th><th>Proxima renovacion</th><th>Motivo</th></tr></thead><tbody>{subscription.reactivations.map((reactivation) => <tr key={reactivation.id}><td>{new Date(reactivation.reactivatedAt).toLocaleString("es-ES")}</td><td>{reactivation.effectiveDate}</td><td>{reactivation.nextRenewalDate}<span className="cell-detail">Anterior: {reactivation.previousNextRenewalDate}</span></td><td>{reactivation.reason}<span className="cell-detail">Baja previa: {reactivation.cancellation.effectiveDate}</span></td></tr>)}</tbody></table></div></div> : null}
      {subscription.reactivationSchedules.length ? <div className="panel stack"><h2>Historial de reactivaciones programadas</h2><div className="table-wrap"><table><thead><tr><th>Fecha efectiva</th><th>Proxima renovacion</th><th>Estado</th><th>Motivo</th><th>Registrada</th></tr></thead><tbody>{subscription.reactivationSchedules.map((schedule) => <tr key={schedule.id}><td>{schedule.effectiveDate}</td><td>{schedule.nextRenewalDate}</td><td>{schedule.status === "PENDING" ? "Pendiente de aplicacion" : schedule.status === "APPLIED" ? "Aplicada" : "Retirada"}</td><td>{schedule.reason}{schedule.revocationReason ? <span className="cell-detail">Retirada: {schedule.revocationReason}</span> : null}</td><td>{new Date(schedule.requestedAt).toLocaleString("es-ES")}{schedule.appliedAt ? <span className="cell-detail">Aplicada: {new Date(schedule.appliedAt).toLocaleString("es-ES")}</span> : null}</td></tr>)}</tbody></table></div></div> : null}
      {subscription.changeSchedules.length ? <div className="panel stack"><h2>Historial de cambios programados</h2><div className="table-wrap"><table><thead><tr><th>Fecha efectiva</th><th>Estado</th><th>Cambios</th><th>Motivo</th><th>Registrado</th></tr></thead><tbody>{subscription.changeSchedules.map((schedule) => <tr key={schedule.id}><td>{schedule.effectiveDate}</td><td>{schedule.status === "PENDING" ? "Pendiente" : schedule.status === "APPLIED" ? "Aplicado" : "Retirado"}</td><td>{schedule.lines.map((line) => <span className="cell-detail" key={line.subscriptionLineId}>Linea {line.position}: {line.previousQuantity} → {line.newQuantity}</span>)}</td><td>{schedule.reason}{schedule.revocationReason ? <span className="cell-detail">Retirada: {schedule.revocationReason}</span> : null}</td><td>{new Date(schedule.requestedAt).toLocaleString("es-ES")}{schedule.appliedAt ? <span className="cell-detail">Aplicado: {new Date(schedule.appliedAt).toLocaleString("es-ES")}</span> : null}</td></tr>)}</tbody></table></div></div> : null}
      {subscription.cancellationSchedules.length ? <div className="panel stack"><h2>Historial de bajas futuras</h2><div className="table-wrap"><table><thead><tr><th>Fecha efectiva</th><th>Estado</th><th>Motivo</th><th>Registrada</th></tr></thead><tbody>{subscription.cancellationSchedules.map((schedule) => <tr key={schedule.id}><td>{schedule.effectiveDate}</td><td>{schedule.status === "PENDING" ? "Pendiente de aplicacion" : schedule.status === "APPLIED" ? "Aplicada" : "Retirada"}</td><td>{schedule.reason}{schedule.revocationReason ? <span className="cell-detail">Retirada: {schedule.revocationReason}</span> : null}{schedule.appliedAt ? <span className="cell-detail">Aplicada: {new Date(schedule.appliedAt).toLocaleString("es-ES")}</span> : null}</td><td>{new Date(schedule.requestedAt).toLocaleString("es-ES")}</td></tr>)}</tbody></table></div></div> : null}
    </section>
  </main>;
}

function nextDate(value: string) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function maxDateOnly(first: string, second: string | null) {
  return second && second > first ? second : first;
}
