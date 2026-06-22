"use client";

import { MessageSquareText } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function WebChatDraftButton({
  draft,
  label = "Ask WebChat",
  size = "sm",
  variant = "outline",
  className,
}: {
  draft: string;
  label?: string;
  size?: "sm" | "default";
  variant?: "outline" | "secondary" | "ghost";
  className?: string;
}) {
  const router = useRouter();
  return (
    <Button
      type="button"
      size={size}
      variant={variant}
      className={className}
      onClick={() => router.push(`/chat?draft=${encodeURIComponent(draft)}`)}
      title={label}
    >
      <MessageSquareText className="mr-2 h-3.5 w-3.5" />
      {label}
    </Button>
  );
}

