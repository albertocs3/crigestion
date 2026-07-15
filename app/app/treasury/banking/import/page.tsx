import Link from "next/link";
import { authorizePagePermission } from "@/modules/platform/presentation/pageAccess";
import { listBankAccounts } from "@/modules/treasury/application/banking";
import { Norma43ImportForm } from "@/modules/treasury/presentation/BankingForms";

export const dynamic = "force-dynamic";

export default async function Norma43ImportPage() {
  const authorization = await authorizePagePermission("Treasury.ImportBankStatements");
  if (!authorization.ok) return <main className="shell"><section className="content"><div className="panel stack"><h1>Importar Norma 43</h1><p className="message error">{authorization.message}</p></div></section></main>;
  const accounts = await listBankAccounts(authorization.user);
  return <main className="shell"><header className="topbar"><div className="brand">CriGestión</div><Link className="button button-secondary" href="/app/treasury/banking">Volver</Link></header><section className="content"><div className="panel stack"><div><p className="eyebrow">Tesoreria</p><h1>Importar extracto Norma 43</h1></div><Norma43ImportForm accounts={accounts.bankAccounts} /></div></section></main>;
}
