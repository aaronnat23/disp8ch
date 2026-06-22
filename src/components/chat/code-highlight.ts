/**
 * Zero-dependency syntax highlighter for chat code blocks.
 *
 * Covers the languages assistants emit ~95% of the time: js/ts/tsx, python,
 * bash/shell, sql, json, css, html. For everything else, returns null so the
 * caller falls back to plain text.
 *
 * Token output is a flat array of { text, kind } pairs. Renderer wraps each in
 * a span with a color class based on kind. Single regex pass per language.
 */

export type Token = { text: string; kind: TokenKind };
export type TokenKind = "plain" | "kw" | "str" | "num" | "com" | "fn" | "ty" | "op" | "tag" | "attr";

const KEYWORDS_JS = new Set([
  "abstract","async","await","boolean","break","case","catch","class","const","continue","debugger","default",
  "delete","do","else","enum","export","extends","false","finally","for","from","function","if","implements",
  "import","in","instanceof","interface","let","new","null","of","private","protected","public","readonly",
  "return","static","super","switch","this","throw","true","try","type","typeof","undefined","var","void","while","yield","as","is","keyof","never","unknown","any","string","number","record",
]);

const KEYWORDS_PY = new Set([
  "False","None","True","and","as","assert","async","await","break","class","continue","def","del","elif","else",
  "except","finally","for","from","global","if","import","in","is","lambda","nonlocal","not","or","pass","raise",
  "return","try","while","with","yield","self","cls",
]);

const KEYWORDS_SQL = new Set([
  "SELECT","FROM","WHERE","INSERT","UPDATE","DELETE","CREATE","TABLE","DROP","ALTER","INDEX","JOIN","LEFT",
  "RIGHT","INNER","OUTER","ON","GROUP","BY","ORDER","HAVING","LIMIT","OFFSET","DISTINCT","AS","AND","OR","NOT",
  "NULL","IS","IN","LIKE","BETWEEN","UNION","ALL","WITH","VALUES","SET","INTO","RETURNING","CASE","WHEN","THEN",
  "ELSE","END","PRIMARY","KEY","FOREIGN","REFERENCES","DEFAULT","UNIQUE","CHECK","CONSTRAINT","IF","EXISTS",
]);

const KEYWORDS_BASH = new Set([
  "if","then","else","fi","case","esac","for","do","done","while","until","function","return","local",
  "export","unset","alias","echo","read","cd","ls","pwd","rm","cp","mv","mkdir","touch","cat","grep","sed","awk","find","exit","source",
]);

function family(language: string): "js" | "py" | "sql" | "bash" | "json" | "css" | "html" | "other" {
  const l = language.toLowerCase();
  if (["js","javascript","jsx","ts","typescript","tsx","mjs","cjs"].includes(l)) return "js";
  if (["py","python","python3"].includes(l)) return "py";
  if (["sql","sqlite","postgres","postgresql","mysql","mariadb"].includes(l)) return "sql";
  if (["sh","bash","zsh","shell","console","cmd"].includes(l)) return "bash";
  if (["json","json5","jsonc","ndjson"].includes(l)) return "json";
  if (["css","scss","less"].includes(l)) return "css";
  if (["html","xml","svg","vue","jsx"].includes(l)) return "html";
  return "other";
}

export function highlightCode(language: string, source: string): Token[] | null {
  const fam = family(language);
  if (fam === "other") return null;

  const tokens: Token[] = [];
  const push = (text: string, kind: TokenKind) => {
    if (text.length === 0) return;
    tokens.push({ text, kind });
  };

  let i = 0;
  while (i < source.length) {
    const ch = source[i];

    // Comments
    if (fam === "js" || fam === "css") {
      if (ch === "/" && source[i + 1] === "/") {
        const end = source.indexOf("\n", i);
        const stop = end === -1 ? source.length : end;
        push(source.slice(i, stop), "com");
        i = stop;
        continue;
      }
      if (ch === "/" && source[i + 1] === "*") {
        const end = source.indexOf("*/", i + 2);
        const stop = end === -1 ? source.length : end + 2;
        push(source.slice(i, stop), "com");
        i = stop;
        continue;
      }
    }
    if (fam === "py" || fam === "bash" || fam === "sql") {
      if (ch === "#" || (fam === "sql" && ch === "-" && source[i + 1] === "-")) {
        const end = source.indexOf("\n", i);
        const stop = end === -1 ? source.length : end;
        push(source.slice(i, stop), "com");
        i = stop;
        continue;
      }
    }
    if (fam === "html") {
      if (ch === "<" && source[i + 1] === "!" && source.startsWith("<!--", i)) {
        const end = source.indexOf("-->", i + 4);
        const stop = end === -1 ? source.length : end + 3;
        push(source.slice(i, stop), "com");
        i = stop;
        continue;
      }
    }

    // Strings
    if (ch === '"' || ch === "'" || (fam === "js" && ch === "`")) {
      const quote = ch;
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === quote) break;
        if (quote !== "`" && source[j] === "\n") break;
        j += 1;
      }
      push(source.slice(i, Math.min(j + 1, source.length)), "str");
      i = Math.min(j + 1, source.length);
      continue;
    }

    // Numbers
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9_.xXbBoOeE+-]/.test(source[j])) j += 1;
      push(source.slice(i, j), "num");
      i = j;
      continue;
    }

    // HTML/XML tag
    if (fam === "html" && ch === "<") {
      const close = source.indexOf(">", i);
      const stop = close === -1 ? source.length : close + 1;
      const inner = source.slice(i, stop);
      // Highlight tag name + attribute names
      const tagMatch = inner.match(/^<\/?([a-zA-Z][\w-]*)/);
      if (tagMatch) {
        push("<" + (inner[1] === "/" ? "/" : ""), "tag");
        push(tagMatch[1], "tag");
        let pos = tagMatch[0].length;
        const attrRe = /\s+([\w:-]+)(?:=("[^"]*"|'[^']*'|[^\s>]+))?/g;
        let m: RegExpExecArray | null;
        attrRe.lastIndex = pos;
        while ((m = attrRe.exec(inner)) !== null) {
          push(inner.slice(pos, m.index), "plain");
          push(" " + m[1], "attr");
          if (m[2] !== undefined) push("=" + m[2], "str");
          pos = m.index + m[0].length;
        }
        push(inner.slice(pos), "tag");
        i = stop;
        continue;
      }
    }

    // Identifiers / keywords
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_$]/.test(source[j])) j += 1;
      const word = source.slice(i, j);
      let kind: TokenKind = "plain";
      if (fam === "js" && KEYWORDS_JS.has(word)) kind = "kw";
      else if (fam === "py" && KEYWORDS_PY.has(word)) kind = "kw";
      else if (fam === "sql" && KEYWORDS_SQL.has(word.toUpperCase())) kind = "kw";
      else if (fam === "bash" && KEYWORDS_BASH.has(word)) kind = "kw";
      else if (fam === "js" && /^[A-Z]/.test(word)) kind = "ty";
      else if (source[j] === "(") kind = "fn";
      push(word, kind);
      i = j;
      continue;
    }

    // JSON property keys: a quoted string before ':' is a property
    if (fam === "json" && (ch === "{" || ch === "[" || ch === "}" || ch === "]" || ch === "," || ch === ":")) {
      push(ch, "op");
      i += 1;
      continue;
    }

    // Operators / punctuation
    if (/[+\-*/%<>=!&|^~?:;,.()\[\]{}]/.test(ch)) {
      push(ch, "op");
      i += 1;
      continue;
    }

    // Whitespace and everything else
    push(ch, "plain");
    i += 1;
  }

  return tokens;
}
