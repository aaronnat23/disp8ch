import { redirect } from "next/navigation";

export default function ResearchDepartmentPage() {
  redirect("/hierarchy?panels=research");
}
