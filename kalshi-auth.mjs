// Optional Kalshi API key — OWNER'S COMPUTER ONLY, READ-ONLY BY CONSTRUCTION.
// The key never goes in the repo, chat, GitHub secrets or the cloud. It lives in private/ (git-ignored):
//   private/kalshi-key-id.txt   the key ID shown by Kalshi
//   private/kalshi-key.pem      your private key (the kalshi.key you generated; only kalshi.pub is uploaded to Kalshi)
// Without these files everything runs on public data exactly as before.
// Safety: only GET requests to an allowlist of read-only portfolio paths can be signed, and the WebSocket only subscribes to
// market-data channels. Anything else throws BEFORE signing. There is no order code in this project.
// Auth (from Kalshi's official starter code): signature of timestamp(ms) + method + path (no query): RSA keys sign with
// RSA-PSS/SHA-256 (MGF1-SHA256, salt = digest length); Ed25519 keys sign the message directly. Checked 2026-11-11 against Kalshi's
// starter code and two public integrations quoting docs.kalshi.com. Keys: unencrypted PEM (RSA PKCS#1/#8, Ed25519 PKCS#8),
// headers KALSHI-ACCESS-KEY / KALSHI-ACCESS-SIGNATURE / KALSHI-ACCESS-TIMESTAMP. Same headers on the WebSocket handshake.
import { existsSync, readFileSync } from "node:fs";
import { createPrivateKey, sign, constants } from "node:crypto";
import { spawnSync } from "node:child_process";

export const KEY_ID_FILE = "private/kalshi-key-id.txt", KEY_FILE = "private/kalshi-key.pem";
const HOST = "https://api.elections.kalshi.com", WS_HOST = "wss://api.elections.kalshi.com";
export const WS_PATH = "/trade-api/ws/v2";
const READ_PATHS = [/^\/trade-api\/v2\/portfolio\/(fills|positions|settlements)$/];  // read-only account history
export const WS_CHANNELS = ["orderbook_delta", "trade", "ticker"];                     // market data only

// Throws unless this exact request is on the read-only allowlist.
export function assertReadOnly(method, path) {
  const p = String(path).split("?")[0];
  if (method !== "GET") throw new Error(`blocked: ${method} is never signed (read-only key use)`);
  if (p !== WS_PATH && !READ_PATHS.some(r => r.test(p))) throw new Error(`blocked: ${p} is not on the read-only allowlist`);
  return p;
}
export function assertChannels(channels) {
  for (const c of channels) if (!WS_CHANNELS.includes(c)) throw new Error(`blocked: channel ${c} is not market data`);
  return channels;
}

// The key is only used when private/ is really git-ignored (the repo is public).
export const privateIgnored = () => spawnSync("git", ["check-ignore", "-q", KEY_FILE]).status === 0;
export const hasKey = () => existsSync(KEY_ID_FILE) && existsSync(KEY_FILE);
let cached = null;
function key() {
  if (!hasKey()) throw new Error("no Kalshi key files in private/");
  if (!privateIgnored()) throw new Error("private/ is not git-ignored: refusing to use the key");
  return cached ||= { id: readFileSync(KEY_ID_FILE, "utf8").trim(), pk: createPrivateKey(readFileSync(KEY_FILE)) };
}

export function signedHeaders(method, path, k = key(), now = Date.now()) {
  const p = assertReadOnly(method, path), ts = String(now);
  const msg = Buffer.from(ts + method + p), sig = k.pk.asymmetricKeyType === "ed25519" ? sign(null, msg, k.pk)
    : sign("sha256", msg, { key: k.pk, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST });
  return { "KALSHI-ACCESS-KEY": k.id, "KALSHI-ACCESS-SIGNATURE": sig.toString("base64"), "KALSHI-ACCESS-TIMESTAMP": ts };
}

// GET a read-only portfolio path, e.g. keyedGet("/portfolio/fills?limit=200").
export async function keyedGet(path) {
  const full = "/trade-api/v2" + path, r = await fetch(HOST + full, { headers: { accept: "application/json", ...signedHeaders("GET", full) } });
  if (!r.ok) throw new Error(`Kalshi HTTP ${r.status} for ${full.split("?")[0]}`);
  return r.json();
}

// Market-data WebSocket for the given tickers. onMsg gets each parsed message. Returns { close }.
export function openStream(tickers, onMsg, onClose = () => {}) {
  const ws = new WebSocket(WS_HOST + WS_PATH, { headers: signedHeaders("GET", WS_PATH) });   // Node 22 built-in WebSocket
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, cmd: "subscribe", params: { channels: assertChannels(["orderbook_delta", "trade"]), market_tickers: tickers } }));
  ws.onmessage = e => { try { onMsg(JSON.parse(e.data)); } catch {} };
  ws.onclose = e => onClose(e.code);
  ws.onerror = () => {};
  return { close: () => { try { ws.close(); } catch {} } };
}

// Check: node kalshi-auth.mjs  → says whether the key works (one read-only call). Never prints the key.
if (import.meta.url === `file://${process.argv[1]}`) {
  if (!hasKey()) { console.log(`No key: put the key ID in ${KEY_ID_FILE} and the private key in ${KEY_FILE}.`); process.exit(0); }
  if (!privateIgnored()) { console.log("private/ is not git-ignored here — the key will not be used."); process.exit(1); }
  try { const j = await keyedGet("/portfolio/fills?limit=1"); console.log(`Key works (read-only): ${key().pk.asymmetricKeyType} key, fills endpoint answered (${(j.fills || []).length} row).`); }
  catch (e) { console.log(`Key did not work: ${e.message}. Check the key ID matches the uploaded public key.`); process.exit(1); }
}
