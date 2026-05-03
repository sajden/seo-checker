import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://seo-api.sebcastwall.se"),
  title: {
    default: "SEO API",
    template: "%s | SEO API"
  },
  description: "API runtime for dashboard SEO checks, GitHub source analysis, and Google Search Console OAuth."
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="sv">
      <body>{children}</body>
    </html>
  );
}
