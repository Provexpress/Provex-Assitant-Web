import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Provex Assistant — Editor de PDFs con IA",
  description: "Rellena formularios PDF automáticamente con inteligencia artificial. Herramienta interna de Provexpress para logística y transporte de carga.",
  icons: {
    icon: "/favicon.png",
    apple: "/brand/provex-icon.png"
  }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="px-theme">{children}</body>
    </html>
  );
}
