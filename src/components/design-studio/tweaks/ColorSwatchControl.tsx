"use client";

export function ColorSwatchControl({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const color = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value) ? value : "#d34a38";
  return (
    <input
      type="color"
      value={color}
      onChange={(event) => onChange(event.target.value)}
      className="h-7 w-8 rounded border border-border bg-transparent p-0.5"
      title={value}
    />
  );
}
