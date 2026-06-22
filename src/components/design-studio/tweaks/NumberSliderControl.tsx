"use client";

export function NumberSliderControl({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const match = value.match(/^([0-9.]+)(px|rem|em|%)?$/);
  const numeric = match ? Number(match[1]) : 8;
  const unit = match?.[2] || "px";
  return (
    <input
      type="range"
      min={0}
      max={unit === "%" ? 100 : 64}
      step={unit === "rem" || unit === "em" ? 0.1 : 1}
      value={Number.isFinite(numeric) ? numeric : 8}
      onChange={(event) => onChange(`${event.target.value}${unit}`)}
      className="h-7 w-24"
      title={value}
    />
  );
}
