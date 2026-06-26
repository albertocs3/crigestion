import type { Metadata } from "next";
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
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
