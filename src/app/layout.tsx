import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tally Signal — Paywalled Market Intelligence",
  description: "A premium market signal API powered by the Tally x402 payment protocol.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
