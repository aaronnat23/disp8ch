import assert from "node:assert/strict";
import net from "node:net";
import { buildStandaloneSidecarEnv, isPortFree, pickFreePort } from "./runtime-manager";

async function main() {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const occupied = address.port;

  assert.equal(await isPortFree(occupied), false);
  const free = await pickFreePort(occupied);
  assert(free > occupied);
  assert.equal(await isPortFree(free), true);

  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.equal(await isPortFree(occupied), true);

  const sourceEnv = { PORT: "3100" } as NodeJS.ProcessEnv;
  assert.equal(buildStandaloneSidecarEnv(sourceEnv, false), sourceEnv);
  const electronSidecarEnv = buildStandaloneSidecarEnv(sourceEnv, true);
  assert.notEqual(electronSidecarEnv, sourceEnv);
  assert.equal(electronSidecarEnv.PORT, "3100");
  assert.equal(electronSidecarEnv.ELECTRON_RUN_AS_NODE, "1");

  console.log("runtime-manager-regression: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
