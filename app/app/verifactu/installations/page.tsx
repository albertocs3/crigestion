import Link from "next/link";
import { getVerifactuSifInstallationManagement } from "@/modules/billing/application/verifactuSifInstallations";
import { VerifactuSifInstallationManager } from "@/modules/billing/presentation/VerifactuSifInstallationManager";
import { authorizePagePermission } from "@/modules/platform/presentation/pageAccess";

export const dynamic = "force-dynamic";

export default async function VerifactuInstallationsPage() {
  const authorization = await authorizePagePermission("Billing.ManageVerifactuInstallations");
  if (!authorization.ok) return <main className="shell"><header className="topbar"><div className="brand">CriGestión</div><Link className="button button-secondary" href="/app">Volver</Link></header><section className="content"><div className="panel stack"><h1>Instalaciones SIF VeriFactu</h1><p className="message error">{authorization.message}</p></div></section></main>;
  const management = await getVerifactuSifInstallationManagement();
  return <main className="shell">
    <header className="topbar"><div className="brand">CriGestión</div><div className="button-row"><Link className="button button-secondary" href="/app/verifactu/credentials">Credenciales</Link><Link className="button button-secondary" href="/app/verifactu/operations">Operaciones</Link><Link className="button button-secondary" href="/app">Inicio</Link></div></header>
    <section className="content stack"><div className="panel stack"><div><p className="eyebrow">Facturación</p><h1>Instalaciones SIF VeriFactu</h1><p className="muted">Crea la identidad técnica TEST antes de importar y activar el certificado mTLS.</p></div>{management ? <VerifactuSifInstallationManager management={management} /> : <p className="message error">La plataforma no tiene una empresa asociada.</p>}</div></section>
  </main>;
}
