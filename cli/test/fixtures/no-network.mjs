/**
 * Test preload (`node --import <this file> dist/bin.js …`): proves a process
 * makes no network request. Every `fetch` and every outbound socket connect
 * is appended to the file named by ARCOPOLIS_TEST_NETWORK_LOG and then
 * refused, so a demo run that reached for the real transport fails loudly
 * and leaves a record. Pipes created from file descriptors (stdio, child
 * processes) never call `connect`, so they are unaffected.
 */
import { appendFileSync } from "node:fs";
import net from "node:net";

const logFile = process.env.ARCOPOLIS_TEST_NETWORK_LOG;

function record(kind, target) {
  if (logFile) appendFileSync(logFile, `${JSON.stringify({ kind, target })}\n`);
}

globalThis.fetch = async (input) => {
  const target = typeof input === "string" ? input : String(input?.url ?? input);
  record("fetch", target);
  throw new TypeError(`network disabled by test preload: ${target}`);
};

net.Socket.prototype.connect = function connect(...args) {
  const first = args[0];
  const target = typeof first === "object" && first !== null ? JSON.stringify({ host: first.host, port: first.port, path: first.path }) : String(first);
  record("socket", target);
  throw new Error(`network disabled by test preload: ${target}`);
};