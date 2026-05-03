import { redirect } from "next/navigation";

export default function HomePage() {
  redirect((process.env.DASHBOARD_URL ?? "https://dashboard.sebcastwall.se") as never);
}
