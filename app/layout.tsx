import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://seo-checker.local"),
  title: {
    default: "SEO Checker",
    template: "%s | SEO Checker"
  },
  description: "Hybrid SEO-checker för source-analyser, crawl och framtida GSC-integration."
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="sv">
      <body>{children}</body>
    </html>
  );
}
