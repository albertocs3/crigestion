import Link from "next/link";
import { authorizePagePermission } from "@/modules/platform/presentation/pageAccess";
import { listSupportCategories } from "@/modules/support/application/incidents";
import { SupportCategoryCreateForm } from "@/modules/support/presentation/SupportCategoryCreateForm";
import { SupportCategoryChangeForm } from "@/modules/support/presentation/SupportCategoryChangeForm";

export const dynamic = "force-dynamic";

export default async function SupportCategoriesPage() {
  const authorization = await authorizePagePermission("Support.ManageCategories");
  if (!authorization.ok) return <main className="shell"><section className="content"><div className="panel stack"><h1>Categorías</h1><p className="message error">{authorization.message}</p></div></section></main>;
  const viewAuthorization = await authorizePagePermission("Support.View");
  if (!viewAuthorization.ok) return <main className="shell"><section className="content"><div className="panel stack"><h1>Categorías</h1><p className="message error">{viewAuthorization.message}</p></div></section></main>;
  const categories = await listSupportCategories();
  return <main className="shell"><header className="topbar"><div className="brand">CriGestión</div><Link className="button button-secondary" href="/app/support">Volver</Link></header><section className="content stack"><div className="panel stack"><h1>Categorías de incidencias</h1><div className="table-wrap"><table><caption>Categorías configuradas para Atención al cliente</caption><thead><tr><th scope="col">Nombre</th><th scope="col">Descripción</th><th scope="col">Color</th><th scope="col">Estado</th><th scope="col">Versión</th><th scope="col">Acciones</th></tr></thead><tbody>{categories.map((category) => <tr key={category.id}><td><strong>{category.name}</strong></td><td>{category.description ?? "—"}</td><td><span aria-hidden="true" style={{ color: category.color }}>●</span> {category.color}</td><td>{category.isActive ? "Activa" : "Inactiva"}</td><td>{category.version}</td><td><SupportCategoryChangeForm category={category}/></td></tr>)}</tbody></table></div></div><div className="panel stack"><SupportCategoryCreateForm/></div></section></main>;
}
