import Link from "next/link";
import { getVerifactuOperations, verifactuOperationsQuerySchema } from "@/modules/billing/application/verifactuOperations";
import { VerifactuOperationsPanel } from "@/modules/billing/presentation/VerifactuOperationsPanel";
import { authorizePagePermission } from "@/modules/platform/presentation/pageAccess";

export const dynamic = "force-dynamic";

export default async function VerifactuOperationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const authorization = await authorizePagePermission("Billing.ViewVerifactuOperations");
  if (!authorization.ok) return <main className="shell"><header className="topbar"><div className="brand">CriGestión</div><Link className="button button-secondary" href="/app">Volver</Link></header><section className="content"><div className="panel stack"><h1>Operaciones VeriFactu</h1><p className="message error">{authorization.message}</p></div></section></main>;
  const raw = await searchParams;
  const parsed = verifactuOperationsQuerySchema.safeParse({ status: scalar(raw.status) ?? "INCIDENTS", operation: scalar(raw.operation) ?? "ALL", environment: scalar(raw.environment) ?? "ALL", search: scalar(raw.search) ?? "" });
  const query = parsed.success ? parsed.data : verifactuOperationsQuerySchema.parse({});
  const dashboard = await getVerifactuOperations(query);
  const canManage = authorization.user.permissions.includes("Billing.ManageVerifactuOperations");
  const canCorrectRejections = authorization.user.permissions.includes("Billing.CreateVerifactuRejectionCorrection");
  const canManageCredentials = authorization.user.permissions.includes("Billing.ManageVerifactuCredentials");
  return <main className="shell"><header className="topbar"><div className="brand">CriGestión</div><div className="button-row">{canManageCredentials ? <Link className="button button-secondary" href="/app/verifactu/credentials">Credenciales</Link> : null}<Link className="button button-secondary" href="/app">Inicio</Link></div></header><section className="content stack"><div className="panel stack"><div><p className="eyebrow">Facturación</p><h1>Operaciones VeriFactu</h1><p className="muted">Supervisión de cola, conciliación, incidencias y caducidad de certificados.</p></div><form className="filter-grid" method="get"><label>Estado<select name="status" defaultValue={query.status}><option value="INCIDENTS">Solo incidencias</option><option value="ALL">Todos</option><option value="PENDING">Pendientes</option><option value="CLAIMED">Procesando</option><option value="PROCESSED">Procesados</option><option value="DEAD">Intervención</option></select></label><label>Operación<select name="operation" defaultValue={query.operation}><option value="ALL">Todas</option><option value="SUBMIT">Envío</option><option value="RECONCILE">Conciliación</option></select></label><label>Entorno<select name="environment" defaultValue={query.environment}><option value="ALL">Todos</option><option value="TEST">TEST</option><option value="PRODUCTION">PRODUCCIÓN</option></select></label><label>Factura<input name="search" defaultValue={query.search} maxLength={80} /></label><button className="button" type="submit">Filtrar</button><Link className="button button-secondary" href="/app/verifactu/operations">Limpiar</Link></form>{dashboard ? <VerifactuOperationsPanel dashboard={dashboard} canManage={canManage} canManageCredentials={canManageCredentials} canCorrectRejections={canCorrectRejections} /> : <p className="message error">La plataforma no tiene empresa asociada.</p>}</div></section></main>;
}

function scalar(value: string | string[] | undefined) { return typeof value === "string" ? value : undefined; }
