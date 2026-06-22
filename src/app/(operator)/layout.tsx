import { ClientOperatorChrome } from "@/components/layout/client-operator-chrome";

// Operator routes are never static; they read URL search params and live data.
// Force dynamic rendering so Next doesn't try to prerender them at build time
// (which would require Suspense wrappers around every useSearchParams call).
export const dynamic = "force-dynamic";

export default function OperatorLayout({ children }: { children: React.ReactNode }) {
  return <ClientOperatorChrome>{children}</ClientOperatorChrome>;
}
