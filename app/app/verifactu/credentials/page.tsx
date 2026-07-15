import Link from "next/link";
import { getVerifactuCredentialManagement } from "@/modules/billing/application/verifactuCredentials";
import { VerifactuCredentialManager } from "@/modules/billing/presentation/VerifactuCredentialManager";
import { authorizePagePermission } from "@/modules/platform/presentation/pageAccess";

export const dynamic = "force-dynamic";

export default async function VerifactuCredentialsPage() {
  const authorization = await authorizePagePermission("Billing.ManageVerifactuCredentials");
  if (!authorization.ok) {
    return <main className="shell"><header className="topbar"><div className="brand">CriGestión</div><Link className="button button-secondary" href="/app">Volver</Link></header><section className="content"><div className="panel stack"><h1>Credenciales VeriFactu</h1><p className="message error">{authorization.message}</p></div></section></main>;
  }
  const management = await getVerifactuCredentialManagement();
  return (
    <main className="shell">
      <header className="topbar"><div className="brand">CriGestión</div><Link className="button button-secondary" href="/app">Volver</Link></header>
      <section className="content stack">
        <div className="panel stack">
          <div className="split-header">
            <div><h1>Credenciales VeriFactu</h1><p className="muted">Importa, prueba y rota certificados mTLS sin exponer el material almacenado.</p></div>
            {authorization.user.permissions.includes("Billing.ManageVerifactuInstallations") ? <Link className="button button-secondary" href="/app/verifactu/installations">Instalaciones SIF</Link> : null}
          </div>
          {management ? <VerifactuCredentialManager management={management} /> : <p className="message error">La instalación de plataforma no tiene una empresa asociada.</p>}
        </div>
      </section>
    </main>
  );
}
