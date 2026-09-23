#!/usr/bin/env node
/**
 * Runs `smoke-tarball.mjs --tarball <http URL>` against the committed latest
 * tarball served from a local HTTP server, so the URL path that
 * `scripts/deploy-api-site.sh` uses after a publish is exercised in CI.
 *
 * The server lives in this process while the smoke test runs as a child, so
 * the child's synchronous `npx` calls cannot block it. It serves only the one
 * tarball, as `application/gzip` with no Content-Encoding (what npm needs),
 * and 404s everything else.
 *
 * Usage: node scripts/smoke-tarball-url.mjs
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const downloads = path.join(cliRoot, "..", "api_site", "downloads");
const manifest = JSON.parse(readFileSync(path.join(downloads, "arcopolis-cli.json"), "utf8"));
const latest = manifest.versions?.find((entry) => entry.version === manifest.latest);
if (!latest) {
  process.stderr.write(`smoke:tarball-url failed: the manifest has no entry for latest ${JSON.stringify(manifest.latest)}.\n`);
  process.exit(1);
}
const bytes = readFileSync(path.join(downloads, latest.file));
let served = 0;

const server = createServer((request, response) => {
  if (request.url === `/downloads/${latest.file}` && (request.method === "GET" || request.method === "HEAD")) {
    served += 1;
    response.writeHead(200, { "content-type": "application/gzip", "content-length": bytes.length });
    response.end(request.method === "HEAD" ? undefined : bytes);
    return;
  }
  response.writeHead(404, { "content-type": "text/plain" });
  response.end("not found\n");
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/downloads/${latest.file}`;

const exitCode = await new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(cliRoot, "scripts", "smoke-tarball.mjs"), "--tarball", url], {
    cwd: cliRoot,
    stdio: "inherit",
  });
  child.on("error", () => resolve(1));
  child.on("exit", (code) => resolve(code ?? 1));
});
server.close();

if (exitCode === 0 && served === 0) {
  process.stderr.write(`smoke:tarball-url failed: npx never requested ${url}.\n`);
  process.exit(1);
}
process.exit(exitCode);
