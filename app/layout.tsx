import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Provex Assistant Web",
  description: "Editor web para rellenar PDFs Provexpress"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <body className="px-theme">{children}</body>
    </html>
  );
}
