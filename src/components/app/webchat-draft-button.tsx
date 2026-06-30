"use client";

import { MessageSquareText } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";

export function WebChatDraftButton({
  draft,
  label = "Ask WebChat",
  size = "sm",
  variant = "outline",
  className,
  sessionId,
}: {
  draft: string;
  label?: string;
  size?: "sm" | "default";
  variant?: "outline" | "secondary" | "ghost";
  className?: string;
  sessionId?: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return (
    <Button
      type="button"
      size={size}
      variant={variant}
      className={className}
      onClick={() => {
        const query = new URLSearchParams();
        query.set("draft", draft);
        const currentQuery = searchParams.toString();
        query.set("returnTo", `${pathname}${currentQuery ? `?${currentQuery}` : ""}`);
        if (sessionId) query.set("sessionId", sessionId);
        router.push(`/chat?${query.toString()}`);
      }}
      title={label}
    >
      <MessageSquareText className="mr-2 h-3.5 w-3.5" />
      {label}
    </Button>
  );
}
