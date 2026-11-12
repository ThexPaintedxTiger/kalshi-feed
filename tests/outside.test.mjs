// Outside data and structure predictors.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import * as WX from "../external/weather.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// ---- Weather regression on the 56 logged Chicago / NYC / LA / Miami rows (2026-11-10/11) that exposed the bug.
//      Fixture: the rows, the index member stations' NWS observations, the official outcomes.
{
  const fx = JSON.parse(gunzipSync(readFileSync(ROOT + "tests/fixtures/weather.json.gz")));
  assert.equal(fx.rows.length, 56); assert.ok(["KXTEMPCHIHS", "KXTEMPNYCHS", "KXTEMPLAXHS"].every(s => fx.rows.some(r => r.series === s)));
  let n = 0, bNew = 0, bOld = 0, agree = 0, settled = 0; const resid = [], oldGap = [];
  for (const r of fx.rows) {
    const I = WX.INDEX[r.series], t = Date.parse(r.ts), T = Date.parse(r.resolvesAt), e = WX.indexEstimate(I.members, fx.obs, t, T), fin = WX.nowcast(I.members, fx.obs, T);
    assert.ok(e, `no estimate for ${r.ticker}`);
    const p = WX.tempProb({ F: e.F, sigma: WX.sigmaFor(e.lead), strikeType: "greater", floor: r.strike });
    assert.ok(p >= 0.03 && p <= 0.97);                                               // clamp 0.97 (the old one reached 0.995)
    n++; bNew += (p - r.y) ** 2; bOld += (r.old - r.y) ** 2; if (/CHI|NYC/.test(r.series)) oldGap.push(r.oldObsF - e.nowcastF);
    if (fin) { settled++; resid.push(fin.F - e.F); if ((fin.F > r.strike ? 1 : 0) === r.y) agree++; }
    // No look-ahead: hiding every observation after the prediction time must not change the estimate.
    const past = Object.fromEntries(Object.entries(fx.obs).map(([k, v]) => [k, v.filter(x => x[0] <= t)]));
    assert.equal(WX.indexEstimate(I.members, past, t, T).F, e.F);
  }
  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  assert.ok(agree / settled >= 0.8, `member-station average matches the official result on only ${agree}/${settled}`);   // it IS the settlement source, approximately
  assert.ok(Math.abs(mean(resid)) < 0.5, `estimate is biased by ${mean(resid).toFixed(2)}°F`);                             // the old estimate ran ~6°F warm
  assert.ok(mean(oldGap) > 2, `in Chicago and New York the old single station should read clearly warmer than the index (${mean(oldGap).toFixed(1)}°F)`);
  assert.ok(bNew / n < bOld / n - 0.1, `rebuilt Brier ${(bNew / n).toFixed(3)} vs old ${(bOld / n).toFixed(3)}`);
  assert.ok(bNew / n < 0.26);                                                        // no longer confidently wrong (a coin flip scores 0.25)
  // Quorum: with fewer than 80% of members reporting there is no estimate at all.
  const I = WX.INDEX.KXTEMPCHIHS, two = Object.fromEntries(I.members.slice(0, 3).map(k => [k, fx.obs[k]]));
  assert.equal(WX.nowcast(I.members, two, Date.parse(fx.rows[0].ts)), null);
}

// ---- ladder: monotone fit across strikes; agreeing quotes are left alone; an off-curve strike is pulled back and flagged.
{
  const { isotonic, fitEvent, fitAll } = await import("../models/ladder.mjs");
  assert.deepEqual(isotonic([1, 3, 2, 4].map(v => ({ v, w: 1 }))), [1, 2.5, 2.5, 4]);
  assert.deepEqual(isotonic([{ v: 3, w: 3 }, { v: 1, w: 1 }]), [2.5, 2.5]);                       // heavier (tighter) quote dominates
  const mk = (K, bid, ask, type = "greater") => ({ ticker: "E-T" + K, event_ticker: "E", strike_type: type, floor_strike: K, cap_strike: type === "between" ? K + 1 : null, yes_bid_dollars: String(bid), yes_ask_dollars: String(ask) });
  const ok = fitEvent([mk(1, 0.88, 0.90), mk(2, 0.60, 0.62), mk(3, 0.30, 0.32), mk(4, 0.05, 0.07)]);
  assert.ok(Object.values(ok).every(x => x.dev === 0 && !x.flag) && Object.keys(ok).length === 4);
  const bad = fitEvent([mk(1, 0.88, 0.90), mk(2, 0.40, 0.42), mk(3, 0.50, 0.52), mk(4, 0.05, 0.07)]);    // strike 3 priced ABOVE strike 2
  assert.equal(bad["E-T2"].p, 0.46); assert.equal(bad["E-T3"].p, 0.46); assert.ok(bad["E-T2"].flag && bad["E-T3"].flag && !bad["E-T1"].flag);
  assert.deepEqual(fitEvent([mk(1, 0.5, 0.52), mk(2, 0.3, 0.32)]), {});                             // too few strikes
  assert.deepEqual(fitEvent([mk(1, 0.5, 0.52), mk(2, 0, 1), mk(3, 0.3, 0.32)]), {});                // unquoted strikes don't count
  const bins = fitEvent([mk(1, 0.20, 0.24, "between"), mk(2, 0.50, 0.54, "between"), mk(3, 0.36, 0.40, "between")]);   // mids sum to 1.12
  assert.equal(bins["E-T2"].sum, 1.12); assert.equal(bins["E-T2"].p, 0.4643); assert.ok(Math.abs(Object.values(bins).reduce((s, x) => s + x.p, 0) - 1) < 1e-3);
  assert.deepEqual(fitEvent([mk(1, 0.20, 0.24, "between"), mk(2, 0.50, 0.54, "between"), mk(3, 0.3, 0.34, "between"), mk(4, 0, 1, "between")]), {});   // incomplete set: sum can't be checked
  assert.equal(Object.keys(fitAll([mk(1, 0.88, 0.90), mk(2, 0.60, 0.62), mk(3, 0.30, 0.32), { ...mk(9, 0.5, 0.6), event_ticker: "LONE" }])).length, 3);
}

// ---- maker portfolio: resting orders fill only when a later real trade crosses, after the queue ahead; never before the order existed.
{
  const { simulate, makerFee, summary } = await import("../maker.mjs");
  const T = Date.parse("2026-01-01T10:00:00Z"), pred = { ts: "2026-01-01T10:00:00Z", resolvesAt: "2026-01-01T11:00:00Z", ticker: "M", event: "EM", bid: 0.40, ask: 0.44, bidSize: 50, askSize: 10 };
  const tr = (min, yes, n, side) => ({ t: T + min * 6e4, yes, n, side });
  assert.equal(makerFee(0.5), 0.01); assert.equal(makerFee(0.4), 0.01);
  assert.equal(simulate(pred, [], 1).yes.filled, false);                                              // no trades → no fills
  assert.equal(simulate(pred, [tr(-5, 0.30, 100, "no")], 1).yes.filled, false);                       // a trade BEFORE the order doesn't count
  assert.equal(simulate(pred, [tr(70, 0.30, 100, "no")], 1).yes.filled, false);                       // nor one after resolution
  assert.equal(simulate(pred, [tr(5, 0.40, 30, "no")], 1).yes.filled, false);                         // 30 traded at our price, 50 were ahead of us
  const q = simulate(pred, [tr(5, 0.40, 30, "no"), tr(9, 0.40, 30, "no")], 1); assert.equal(q.yes.filled, true); assert.equal(q.yes.at, "2026-01-01T10:09:00.000Z"); assert.equal(q.yes.pnl, 0.59);   // 1 − 0.40 − 0.01
  assert.equal(simulate(pred, [tr(5, 0.39, 1, "no")], 0).yes.pnl, -0.41);                             // traded through → filled, and it lost
  assert.equal(simulate(pred, [tr(5, 0.39, 1, "yes")], 0).yes.filled, false);                         // a taker BUYING yes never hits our yes bid
  const n = simulate(pred, [tr(5, 0.45, 1, "yes")], 0); assert.equal(n.no.filled, true); assert.equal(n.no.px, 0.56); assert.equal(n.no.pnl, 0.43);   // NO bid at 0.56 hit; NO won
  const both = simulate(pred, [tr(5, 0.39, 1, "no"), tr(6, 0.45, 1, "yes")], 1); assert.equal(both.pnl, 0.02);     // both sides filled: 1 − 0.40 − 0.56 − 0.02 fees = the spread
  const sm = summary([q, n, both]); assert.equal(sm.orders, 6); assert.equal(sm.fills, 4); assert.equal(sm.roundTrips, 1); assert.equal(sm.pnl, 1.04);
}

// ---- Crypto reference: the settlement index from the stream when fresh; otherwise the median of exchanges; a venue far off is dropped.
{
  const CR = await import("../external/crypto.mjs"), { Engine } = await import("../live/engine.mjs");
  assert.equal(CR.indexId("BTC-USD"), "BRTI"); assert.equal(CR.indexId("ETH-USD"), "ETHUSD_RTI"); assert.equal(CR.median([3, 1, 2]), 2); assert.equal(CR.median([1, 3]), 2);
  const e = new Engine(); e.onMessage({ type: "cfbenchmarks_value", msg: { index_id: "BRTI", data: JSON.stringify({ value: "68000.12" }), avg_60s_data: { value: "68001.00" } } }, 1000);
  assert.deepEqual(e.index.get("BRTI"), { value: 68000.12, avg60: 68001, at: 1000 });
  CR.setReference(id => e.index.get(id));
  assert.deepEqual(await CR.referenceSpot("BTC-USD", 67990, 5000), { spot: 68000.12, src: "cf-benchmarks (Kalshi stream)", n: 1 });
  CR.setReference(() => null); assert.equal((await CR.referenceSpot("HYPE-USD", 70)).src, "coinbase");   // no other venue mapped → Coinbase only
}
