import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { authorizePagePermission } from "@/modules/platform/presentation/pageAccess";
import { getSupplier } from "@/modules/suppliers/application/suppliers";
import { SupplierForm } from "@/modules/suppliers/presentation/SupplierForm";

export const dynamic = "force-dynamic";
const paramsSchema = z.object({ supplierId: z.string().uuid() });

export default async function SupplierPage({ params }: { params: Promise<{ supplierId: string }> }) {
  const authorization = await authorizePagePermission("Suppliers.View");
  if (!authorization.ok) return <main className="shell"><section className="content"><div className="panel stack"><h1>Proveedor</h1><p className="message error">{authorization.message}</p><Link className="button button-secondary" href="/app/suppliers">Volver</Link></div></section></main>;
  const parsed = paramsSchema.safeParse(await params); if (!parsed.success) notFound();
  const result = await getSupplier(parsed.data.supplierId, authorization.user); if (!result.ok) notFound();
  const supplier = result.value; const canManage = authorization.user.permissions.includes("Suppliers.Manage");
  return <main className="shell"><header className="topbar"><div className="brand">CriGestión</div><Link className="button button-secondary" href="/app/suppliers">Volver</Link></header><section className="content stack">
    <div className="panel stack"><h1>{supplier.legalName}</h1><p className="muted">{supplier.code} · subcuenta {supplier.accountingCode} · NIF/VAT {supplier.taxIdMasked}</p><dl className="detail-grid"><div><dt>Dirección fiscal</dt><dd>{supplier.fiscalAddress.line}, {supplier.fiscalAddress.postalCode} {supplier.fiscalAddress.city} ({supplier.fiscalAddress.country})</dd></div><div><dt>Contacto</dt><dd>{supplier.contact.name ?? "Sin contacto"}; {supplier.contact.hasEmail ? "email guardado" : "sin email"}; {supplier.contact.hasPhone ? "teléfono guardado" : "sin teléfono"}</dd></div><div><dt>Banco</dt><dd>{supplier.banking.ibanMasked ?? "Sin IBAN"}</dd></div><div><dt>Estado</dt><dd>{supplier.status === "ACTIVE" ? "Activo" : "Inactivo"}</dd></div></dl></div>
    {canManage ? <div className="panel stack"><SupplierForm supplier={supplier}/></div> : null}
  </section></main>;
}
