"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { HelpCircle, Check } from "lucide-react";

export function ClarifyCard({
  question,
  choices,
  context,
  onSelect,
}: {
  question: string;
  choices: string[];
  context?: string;
  onSelect: (choice: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);

  const handleSelect = (choice: string) => {
    setSelected(choice);
    onSelect(choice);
  };

  return (
    <div className="mt-3 rounded-md border border-blue-500/30 bg-blue-500/5 px-4 py-3">
      <div className="mb-2 flex items-center gap-2">
        <HelpCircle className="h-4 w-4 text-blue-500" />
        <span className="text-sm font-semibold text-foreground">Clarification needed</span>
      </div>
      {context ? (
        <p className="mb-3 text-xs text-muted-foreground">{context}</p>
      ) : null}
      <p className="mb-3 text-sm font-medium text-foreground">{question}</p>
      <div className="flex flex-wrap gap-2">
        {choices.map((choice) => (
          <Button
            key={choice}
            variant={selected === choice ? "default" : "outline"}
            size="sm"
            className="h-8 text-xs"
            onClick={() => handleSelect(choice)}
            disabled={selected !== null}
          >
            {selected === choice ? <Check className="mr-1 h-3 w-3" /> : null}
            {choice}
          </Button>
        ))}
      </div>
      {selected ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Selected: {selected}
        </p>
      ) : null}
    </div>
  );
}
