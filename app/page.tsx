import { Suspense } from "react";
import { AnalyzerForm } from "@/components/analyzer-form";

export default function HomePage() {
  return (
    <Suspense fallback={<main className="page-shell"><section className="panel">Loading SEO Monitor...</section></main>}>
      <AnalyzerForm />
    </Suspense>
  );
}
