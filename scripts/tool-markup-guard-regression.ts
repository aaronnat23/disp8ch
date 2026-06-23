#!/usr/bin/env tsx
import { hasLeakedToolMarkup, hasLeakedToolMarkupDeep } from "../src/lib/channels/tool-markup-guard";

function check(name: string, ok: boolean) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  check("wrapper markup is detected", hasLeakedToolMarkup("<tool_call name=\"read_file\">x</tool_call>"));
  check(
    "single direct tool element is detected",
    await hasLeakedToolMarkupDeep("I will inspect it.\n<browser_navigate><url>http://localhost</url></browser_navigate>"),
  );
  check(
    "normal prose tool discussion is allowed",
    !(await hasLeakedToolMarkupDeep("The browser_navigate tool opens a page before browser_snapshot reads it.")),
  );
  check(
    "fenced examples are allowed",
    !(await hasLeakedToolMarkupDeep("Example only\n```xml\n<browser_navigate><url>https://example.com</url></browser_navigate>\n```")),
  );
  if (process.exitCode) process.exit(1);
  console.log("\ntool-markup-guard-regression: 4/4 passed");
}

void main();
