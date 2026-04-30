import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://seo-monitor.local"),
  title: {
    default: "SEO Monitor",
    template: "%s | SEO Monitor"
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
