import { Parser } from "expr-eval";

const parser = new Parser({ operators: { logical: false, comparison: false, in: false, assignment: false } });
const NUMBER_WORDS: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5",
  six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11",
  twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16",
  seventeen: "17", eighteen: "18", nineteen: "19", twenty: "20",
};

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
}

/** Evaluate a bounded, arithmetic-only user request. Returns null for non-math text. */
export function evaluateSimpleCalculation(message: string): string | null {
  let expression = String(message || "").trim().toLowerCase();
  if (!expression || expression.length > 160) return null;

  const percent = expression.match(/(?:what\s+is\s+|calculate\s+)?(\d+(?:\.\d+)?)\s*(?:%|percent)\s+of\s+(\d+(?:\.\d+)?)/i);
  if (percent) expression = `((${percent[1]}) / 100) * (${percent[2]})`;
  else {
    expression = expression
      .replace(/^(?:please\s+)?(?:what\s+is|what's|calculate|compute|evaluate|solve)\s+/i, "")
      .replace(/\s+(?:for\s+me|please)\s*[?.!]*$/i, "")
      .replace(/[?.!,]+$/g, "")
      .replace(/\bmultiplied\s+by\b|\btimes\b|(?<=\s)x(?=\s)/g, "*")
      .replace(/\bdivided\s+by\b|\bover\b/g, "/")
      .replace(/\bplus\b/g, "+")
      .replace(/\bminus\b/g, "-")
      .replace(/\bmod(?:ulo)?\b/g, "%")
      .replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/g, (word) => NUMBER_WORDS[word] || word)
      .trim();
  }

  if (!/[+\-*/%]/.test(expression) || !/^[\d\s.+\-*/%()]+$/.test(expression)) return null;
  try {
    const value = Number(parser.evaluate(expression));
    return Number.isFinite(value) ? formatNumber(value) : null;
  } catch {
    return null;
  }
}
