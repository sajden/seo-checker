import { Suspense } from "react";
import { AnalyzerForm } from "@/components/analyzer-form";

export default function HomePage() {
  return (
    <Suspense fallback={null}>
      <AnalyzerForm />
    </Suspense>
  );
}
