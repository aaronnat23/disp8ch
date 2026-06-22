import { redirect } from "next/navigation";

export default function CostsRedirect() {
  redirect("/metrics");
}
