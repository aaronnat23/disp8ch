#!/usr/bin/env tsx
/** Phase 7 regression: disp8ch:// deep-link parsing safety. */
import { deepLinkFromArgv, parseDeepLink } from "../desktop/deeplink";

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}

const session = parseDeepLink("disp8ch://session/sess-123");
check("session.parsed", session.action === "open-session" && session.action === "open-session" && session.sessionId === "sess-123");

const sessionQuery = parseDeepLink("disp8ch://session?id=abc");
check("session.queryId", sessionQuery.action === "open-session" && sessionQuery.sessionId === "abc");

const nav = parseDeepLink("disp8ch://open/workflows");
check("nav.route", nav.action === "navigate" && nav.route === "/workflows");

const navPath = parseDeepLink("disp8ch://open?path=/chat");
check("nav.queryPath", navPath.action === "navigate" && navPath.route === "/chat");

const wrongProto = parseDeepLink("https://evil.com/x");
check("ignore.wrongProtocol", wrongProto.action === "ignore");

const injection = parseDeepLink("disp8ch://open//evil.com");
check(
  "nav.noProtocolRelative",
  injection.action === "navigate" && injection.route.startsWith("/") && !injection.route.startsWith("//"),
);
const schemeInjection = parseDeepLink("disp8ch://open?path=https://evil.com");
check("nav.noSchemeInjection", schemeInjection.action === "navigate" && schemeInjection.route === "/");

const garbage = parseDeepLink("not a url");
check("ignore.garbage", garbage.action === "ignore");

const unknown = parseDeepLink("disp8ch://wat/ever");
check("ignore.unknownHost", unknown.action === "ignore");

check("argv.finds", deepLinkFromArgv(["electron", ".", "disp8ch://session/x"]) === "disp8ch://session/x");
check("argv.none", deepLinkFromArgv(["electron", "."]) === null);

const failed = results.filter((r) => !r.ok);
console.log(`\ndeeplink-regression: ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  console.error("Failed:", failed.map((r) => r.name).join(", "));
  process.exit(1);
}
