// engine-loopback-e2e.mjs — the REAL WebRTC stack, in CI, no Calimero needed.
//
// Bundles src/lib/webrtc.ts (the CallEngine) and runs TWO engines inside one
// headless Chromium page, wired to each other through an in-page signaling
// bridge that emulates the Calimero contract channel: per-message latency
// (gossip is seconds, not ms) and injectable signal LOSS. Real
// RTCPeerConnections, real ICE over host candidates, real fake-camera media —
// so negotiation, glare, reconnect and the lost-offer watchdog are exercised
// against the browser's actual WebRTC implementation, not fakes.
//
// Phases:
//   1. both engines join → media frames flow BOTH ways (real decoded video)
//   2. deliberate GLARE (both offer simultaneously) → still converges
//   3. force reconnect (rebuildAll) → media re-flows
//   4. lost-offer: drop the first offer after a rebuild → handshake-timeout
//      watchdog must recover the call on its own
//   5. bye teardown → peer closes cleanly
//
// Usage:  node scripts/engine-loopback-e2e.mjs      (CI: after playwright install chromium)
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(__dirname, "..");

const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const die = (m) => {
  console.error(`FAILED: ${m}`);
  process.exit(1);
};

// ── 1. Bundle the engine (esbuild ships with vite) ────────────────────────────
log("bundling CallEngine…");
const bundle = execFileSync(
  path.join(APP, "node_modules", ".bin", "esbuild"),
  [
    path.join(APP, "src", "lib", "webrtc.ts"),
    "--bundle",
    "--format=iife",
    "--global-name=MeroEngine",
  ],
  { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);

// ── 2. Real browser, fake camera ──────────────────────────────────────────────
const browser = await chromium.launch({
  headless: true,
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    // Same-page loopback: plain host candidates, no mDNS resolution needed.
    "--disable-features=WebRtcHideLocalIpsWithMdns",
    "--allow-loopback-in-peer-connection",
  ],
});
const page = await (await browser.newContext({ permissions: ["camera", "microphone"] })).newPage();
page.on("pageerror", (e) => log(`pageerror: ${e.message}`));
// getUserMedia needs a SECURE CONTEXT — about:blank has an opaque origin and
// no mediaDevices. localhost is always secure; fulfill it without a server.
await page.route("http://localhost:8899/**", (route) =>
  route.fulfill({ contentType: "text/html", body: "<!doctype html><title>loopback</title>" }),
);
await page.goto("http://localhost:8899/");
await page.addScriptTag({ content: bundle });

// ── 3. Two engines + a lossy, laggy in-page signaling bridge ──────────────────
await page.evaluate(() => {
  const LATENCY_MS = 300; // emulate gossip propagation
  const A_ID = "aaa-peer-A";
  const B_ID = "zzz-peer-B";
  const state = (window.T = {
    diags: [],
    dropNext: { offer: 0, answer: 0, ice: 0, bye: 0 }, // per-kind loss injection
    videos: {},
  });

  function bridge(fromLabel, toEngineGetter) {
    return (sig) => {
      if (state.dropNext[sig.kind] > 0) {
        state.dropNext[sig.kind] -= 1;
        state.diags.push(`DROPPED ${sig.kind} from ${fromLabel}`);
        return; // the gossip ate it
      }
      setTimeout(() => {
        const target = toEngineGetter();
        void target.handleSignal(fromLabel, sig.kind, sig.payload);
      }, LATENCY_MS);
    };
  }

  function attachVideo(key, stream) {
    let v = state.videos[key];
    if (!v) {
      v = document.createElement("video");
      v.autoplay = true;
      v.playsInline = true;
      v.muted = true;
      document.body.appendChild(v);
      state.videos[key] = v;
    }
    v.srcObject = stream;
  }

  const mk = (selfId, label, peerLabel, remoteKey) =>
    new MeroEngine.CallEngine(selfId, {
      onLocalStream: () => {},
      onRemoteStream: (_id, stream) => {
        if (stream) attachVideo(remoteKey, stream);
      },
      onSignal: bridge(label === "A" ? A_ID : B_ID, () => (label === "A" ? state.B : state.A)),
      onPeerStateChange: (_id, st) => state.diags.push(`${label}:peer→${st}`),
      onDiag: (d) => state.diags.push(`${label}:${d.msg}`),
    });

  state.A = mk(A_ID, "A", B_ID, "remoteAtA");
  state.B = mk(B_ID, "B", A_ID, "remoteAtB");
  state.ids = { A_ID, B_ID };
});

/** Do both remote videos have REAL decoded frames advancing? */
async function bothDirectionsFlow(timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    const ok = await page.evaluate(async () => {
      const vids = [window.T.videos.remoteAtA, window.T.videos.remoteAtB];
      if (vids.some((v) => !v)) return false;
      const t = vids.map((v) => v.currentTime);
      await new Promise((r) => setTimeout(r, 500));
      return vids.every((v, i) => v.videoWidth > 0 && v.currentTime > t[i]);
    });
    if (ok) {
      log(`  ${label}: media flowing both ways after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return;
    }
    if (Date.now() - t0 > timeoutMs) {
      const diags = await page.evaluate(() => window.T.diags.slice(-40));
      console.error(diags.join("\n"));
      die(`${label}: no two-way media after ${timeoutMs / 1000}s`);
    }
    await page.waitForTimeout(500);
  }
}

try {
  log("PHASE 1 — join: both engines start, roster sync, media must flow both ways");
  await page.evaluate(async () => {
    const { A_ID, B_ID } = window.T.ids;
    await Promise.all([window.T.A.start(), window.T.B.start()]);
    // Both sides add each other simultaneously → both offer → REAL glare,
    // resolved by politeness on the real browser stack.
    window.T.A.syncPeers([A_ID, B_ID]);
    window.T.B.syncPeers([A_ID, B_ID]);
  });
  await bothDirectionsFlow(20_000, "initial connect (with glare)");
  log("PHASE 1 OK ✅");

  log("PHASE 2 — force reconnect: A rebuilds every pc, media must re-flow");
  // Serialize on the STATE MACHINE, not on frames: the kept-stream tile can
  // keep decoding old media for a moment, which let the flow check pass
  // before the rebuild even took effect (and phase 3 then raced phase 2).
  const reconnectsBefore = await page.evaluate(
    () => window.T.diags.filter((d) => d === "A:peer→connected").length,
  );
  await page.evaluate(() => window.T.A.rebuildAll());
  {
    const t0 = Date.now();
    for (;;) {
      const n = await page.evaluate(
        () => window.T.diags.filter((d) => d === "A:peer→connected").length,
      );
      if (n > reconnectsBefore) break;
      if (Date.now() - t0 > 25_000) {
        console.error((await page.evaluate(() => window.T.diags.slice(-40))).join("\n"));
        die("rebuilt connection never reached connected");
      }
      await page.waitForTimeout(300);
    }
  }
  await bothDirectionsFlow(15_000, "after rebuildAll");
  log("PHASE 2 OK ✅");

  log("PHASE 3 — lost offer: drop A's next offer; the handshake watchdog must self-heal");
  await page.evaluate(() => {
    window.T.dropNext.offer = 1; // gossip eats exactly one offer
    window.T.A.rebuildAll(); // fresh pc → its offer will be the dropped one
  });
  // Prove the chain: (1) the offer was actually lost, (2) the handshake
  // watchdog detected the dead handshake and rebuilt, (3) media re-flows.
  const waitDiag = async (pred, label, timeoutMs) => {
    const t0 = Date.now();
    for (;;) {
      const hit = await page.evaluate((src) => {
        const fn = new Function("d", `return ${src};`);
        return window.T.diags.some((d) => fn(d));
      }, pred);
      if (hit) return;
      if (Date.now() - t0 > timeoutMs) {
        console.error((await page.evaluate(() => window.T.diags.slice(-40))).join("\n"));
        die(`${label} not observed within ${timeoutMs / 1000}s`);
      }
      await page.waitForTimeout(300);
    }
  };
  await waitDiag('d.startsWith("DROPPED offer")', "offer loss", 10_000);
  log("  offer dropped by the bridge; waiting for the watchdog…");
  await waitDiag('d.includes("handshake dead")', "handshake watchdog", 30_000);
  log("  watchdog fired; waiting for media to recover…");
  await bothDirectionsFlow(30_000, "after lost offer (watchdog recovery)");
  log("PHASE 3 OK ✅");

  log("PHASE 4 — bye: B leaves, A must close the peer");
  await page.evaluate(() => window.T.B.stop());
  const t0 = Date.now();
  for (;;) {
    const n = await page.evaluate(async () => (await window.T.A.getStats()).length);
    if (n === 0) break;
    if (Date.now() - t0 > 10_000) die("A still holds a peer 10s after B said bye");
    await page.waitForTimeout(500);
  }
  log("PHASE 4 OK ✅");

  log("ALL ENGINE-LOOPBACK PHASES PASSED 🎉");
} finally {
  await browser.close();
}
