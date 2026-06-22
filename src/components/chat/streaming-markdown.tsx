"use client";

import { useMemo, useRef } from "react";
import { cn } from "@/lib/utils";
import { ChatMarkdown } from "@/components/chat/chat-markdown";

interface StreamingMarkdownProps {
  content: string;
  className?: string;
}

function findStableBoundary(text: string): number {
  const paragraphBoundary = text.lastIndexOf("\n\n");
  if (paragraphBoundary < 0) return 0;

  let boundary = paragraphBoundary + 2;
  const candidate = text.slice(0, boundary);
  const fences = candidate.match(/```/g)?.length ?? 0;
  if (fences % 2 === 0) return boundary;

  const openFence = candidate.lastIndexOf("```");
  const previousParagraph = candidate.lastIndexOf("\n\n", Math.max(0, openFence - 1));
  boundary = previousParagraph >= 0 ? previousParagraph + 2 : 0;
  return boundary;
}

export function StreamingMarkdown({ content, className }: StreamingMarkdownProps) {
  const committedRef = useRef("");
  const stableBoundary = findStableBoundary(content);

  if (stableBoundary > committedRef.current.length) {
    committedRef.current = content.slice(0, stableBoundary);
  }
  if (!content.startsWith(committedRef.current)) {
    committedRef.current = content.slice(0, stableBoundary);
  }

  const committed = committedRef.current;
  const tail = content.slice(committed.length);

  const committedMarkdown = useMemo(
    () => committed ? <ChatMarkdown content={committed} className="space-y-3" /> : null,
    [committed],
  );

  return (
    <div className={cn("space-y-3 text-sm leading-6", className)}>
      {committedMarkdown}
      {tail ? <ChatMarkdown content={tail} className="stream-fade-word space-y-3" /> : null}
    </div>
  );
}
