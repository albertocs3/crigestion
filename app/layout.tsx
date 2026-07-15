import type { Metadata } from "next";
import { readOperationalEnvironment } from "@/modules/platform/application/operationalEnvironment";
import "./globals.css";

export const metadata: Metadata = {
  title: "CriGestión",
  description: "Gestion empresarial integrada"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  const environment = readOperationalEnvironment(process.env);
  return (
    <html lang="es">
      <body>
        {environment.isTestMode ? (
          <aside className={`environment-banner ${environment.testIsolationConfigured ? "" : "environment-banner-unverified"}`}
            aria-label="Entorno de ejecucion">
            <strong>ENTORNO {environment.appEnvironment} · {environment.databaseConfiguredAsTest
              ? environment.expectedDatabaseName
              : "BASE NO VERIFICADA"}</strong>
            <span>{environment.testIsolationConfigured
              ? (environment.verifactuEnabled ? "AEAT TEST" : "VERIFACTU DESACTIVADO")
              : "CONFIGURACION NO AISLADA"}</span>
          </aside>
        ) : null}
        {children}
      </body>
    </html>
  );
}
