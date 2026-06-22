import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const windows = fs.readFileSync(path.join(root, "scripts", "install-windows.ps1"), "utf8");
const shell = fs.readFileSync(path.join(root, "scripts", "install.sh"), "utf8");
const wrapper = fs.readFileSync(path.join(root, "install.ps1"), "utf8");

assert.match(windows, /\[string\]\$SourceZip/);
assert.match(windows, /DISP8CH_SOURCE_ZIP_URL/);
assert.match(windows, /Install-SourceZip/);
assert.match(windows, /archive\/refs\/heads\/\$Branch\.zip/);
assert.match(windows, /run inside a disp8ch checkout/);

assert.match(shell, /--source-zip/);
assert.match(shell, /DISP8CH_SOURCE_ZIP_URL/);
assert.match(shell, /install_source_zip/);
assert.match(shell, /command -v unzip/);
assert.match(shell, /archive\/refs\/heads\/%s\.zip/);
assert.match(shell, /run inside a disp8ch checkout/);

assert.match(wrapper, /SourceZip/);
assert.match(wrapper, /SkipBrowserOpen/);
assert.match(wrapper, /NonInteractive/);
assert.match(wrapper, /Stage/);

console.log("installer-script-regression: ok");
