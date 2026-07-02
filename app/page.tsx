import { redirect } from "next/navigation";
import { requireAuthenticatedPage } from "@/modules/platform/presentation/pageAccess";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  await requireAuthenticatedPage();

  redirect("/app");
}
