// useCallController tests — the signaling/roster brain where every historical
// "the call worked at first and then broke" bug lived. The real CallEngine runs
// against a scripted fake RTCPeerConnection (as in webrtc.test.ts); the contract
// side is a FakeMeet that mimics the WASM semantics the controller depends on:
// an addressed mailbox with monotonic (but collidable) seqs, a derived call
// roster, and presence rows. Scenarios are asserted end-to-end: "a stale offer
// must not replay" is observed as "no answer was posted", not by peeking at refs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { LobbyView, Presence, Signal } from "../types";

const SELF = "self-mm";
const PEER = "aaa-peer";
const PEER2 = "bbb-peer";

// ── Module mocks (hoisted state so factories can reach it) ────────────────────

const H = vi.hoisted(() => ({
  meet: null as unknown as Record<string, unknown>,
  sse: null as ((evt: { contextId: string; data: unknown }) => void) | null,
  username: "Fran",
  ctx: "ctx1" as string | null,
}));

vi.mock("./useMeroMeet", () => ({ useMeroMeet: () => H.meet }));
vi.mock("@calimero-network/mero-react", () => ({
  useSubscription: (ids: string[], cb: (evt: { contextId: string; data: unknown }) => void) => {
    if (ids.length) H.sse = cb;
  },
}));
vi.mock("../lib/tauri", () => ({
  invokeTauri: () => Promise.reject(new Error("no tauri in tests")),
}));
vi.mock("../lib/effects", () => ({
  BackgroundProcessor: class {
    start() {
      return Promise.resolve(new MediaStream());
    }
    pause() {}
    close() {}
  },
}));
vi.mock("../lib/session", () => ({
  getContextId: () => H.ctx,
  getExecutorPublicKey: () => "self-mm",
  getUsername: () => H.username,
}));

import { useCallController, type CallController } from "./useCall";

// ── WebRTC fakes (the slice CallEngine touches) ───────────────────────────────

class FakeTrack {
  enabled = true;
  stop = vi.fn();
  constructor(public kind: "audio" | "video") {}
  getSettings() {
    return { width: 640, height: 480, frameRate: 30 };
  }
}

class FakeMediaStream {
  private tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] = []) {
    this.tracks = [...tracks];
  }
  getTracks() {
    return [...this.tracks];
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === "video");
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === "audio");
  }
  addTrack(t: FakeTrack) {
    this.tracks.push(t);
  }
  removeTrack(t: FakeTrack) {
    this.tracks = this.tracks.filter((x) => x !== t);
  }
}

type Desc = { type: "offer" | "answer"; sdp: string };

class FakePC {
  static all: FakePC[] = [];
  localDescription: Desc | null = null;
  remoteDescription: Desc | null = null;
  signalingState = "stable";
  connectionState: RTCPeerConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "complete";
  onicecandidate: ((e: { candidate: unknown }) => void) | null = null;
  ontrack: ((e: { streams: unknown[] }) => void) | null = null;
  onnegotiationneeded: (() => void | Promise<void>) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  restartIce = vi.fn();
  setConfiguration = vi.fn();
  closed = false;
  /** Test hook: entries returned by getStats() (report-shaped). */
  statsEntries: Array<{ type: string; bytesSent?: number; bytesReceived?: number }> = [];
  async getStats() {
    const entries = this.statsEntries;
    return { forEach: (fn: (e: unknown) => void) => entries.forEach(fn) };
  }
  private senders: { track: unknown; replaceTrack: ReturnType<typeof vi.fn> }[] = [];
  private negotiationQueued = false;

  constructor(public config: unknown) {
    FakePC.all.push(this);
  }
  addTrack(track: unknown) {
    const s = { track, replaceTrack: vi.fn(async (t: unknown) => void (s.track = t)) };
    this.senders.push(s);
    if (!this.negotiationQueued) {
      this.negotiationQueued = true;
      queueMicrotask(() => {
        this.negotiationQueued = false;
        void this.onnegotiationneeded?.();
      });
    }
    return s;
  }
  getSenders() {
    return this.senders;
  }
  async setLocalDescription(desc?: Desc) {
    const answering = this.remoteDescription?.type === "offer";
    this.localDescription = desc ?? { type: answering ? "answer" : "offer", sdp: "sdp" };
    this.signalingState = answering ? "stable" : "have-local-offer";
  }
  async setRemoteDescription(desc: Desc) {
    this.remoteDescription = desc;
    this.signalingState = desc.type === "offer" ? "have-remote-offer" : "stable";
  }
  async addIceCandidate(_c: unknown) {}
  addEventListener(_e: string, _f: () => void) {}
  removeEventListener(_e: string, _f: () => void) {}
  close() {
    this.closed = true;
    this.connectionState = "closed";
  }
  setConn(s: RTCPeerConnectionState) {
    this.connectionState = s;
    this.onconnectionstatechange?.();
  }
}

// ── Fake contract ─────────────────────────────────────────────────────────────

function presenceRow(id: string, updatedAt: number, over: Partial<Presence> = {}): Presence {
  return {
    memberId: id,
    username: id.slice(0, 3),
    status: "in_call",
    muted: false,
    videoOn: true,
    callId: "call-1",
    joinedAt: 0,
    updatedAt,
    ...over,
  };
}

class FakeMeet {
  contextId = "ctx1";
  executorId = SELF;
  loading = false;
  error = null;

  mailbox: Signal[] = [];
  nextSeq = 0;
  /** What get_call_participants returns; null = RPC failure. */
  roster: string[] | null = [SELF];
  members: Presence[] = [];
  callIdToMint: string | null = "call-1";
  counts = { join: 0, heartbeat: 0, startCall: 0, leaveCall: 0, postSignal: 0, getSignals: 0 };
  failNext = { postSignal: 0, getSignals: 0, startCall: 0 };
  /** Every successfully-posted outbound signal, in order. */
  posted: Array<{ to: string; kind: string; payload: string }> = [];

  join = async () => {
    this.counts.join += 1;
    return {};
  };
  heartbeat = async () => {
    this.counts.heartbeat += 1;
    return {};
  };
  setState = async () => ({});
  leave = async () => ({});
  getLobby = async (): Promise<LobbyView> => ({
    room: { name: "standup", owner: null, memberCount: this.members.length, onlineCount: 0, activeCall: "call-1" },
    members: [...this.members],
    online: [],
  });
  startCall = async () => {
    this.counts.startCall += 1;
    if (this.failNext.startCall > 0) {
      this.failNext.startCall -= 1;
      return null;
    }
    return this.callIdToMint;
  };
  leaveCall = async () => {
    this.counts.leaveCall += 1;
    return {};
  };
  endCall = async () => ({});
  getCallParticipants = async () => (this.roster ? [...this.roster] : null);
  postSignal = async (to: string, kind: string, payload: string, _callId: string) => {
    this.counts.postSignal += 1;
    if (this.failNext.postSignal > 0) {
      this.failNext.postSignal -= 1;
      return null;
    }
    this.posted.push({ to, kind, payload });
    this.nextSeq += 1;
    this.mailbox.push({
      id: `sig-${this.nextSeq}-${SELF.slice(0, 8)}`,
      seq: this.nextSeq,
      from: SELF,
      to,
      kind,
      payload,
      callId: "call-1",
      createdAt: 0,
    });
    return this.nextSeq;
  };
  getSignals = async (after: number) => {
    this.counts.getSignals += 1;
    if (this.failNext.getSignals > 0) {
      this.failNext.getSignals -= 1;
      return null;
    }
    return this.mailbox
      .filter((s) => s.to === SELF && s.seq > after)
      .sort((a, b) => a.seq - b.seq);
  };
  postMessage = async () => 0;
  getMessages = async () => [];

  /** A peer posts a signal addressed to us (lands in the mailbox). */
  inject(from: string, kind: string, payload = "", seq?: number): Signal {
    const s = seq ?? (this.nextSeq += 1);
    if (seq !== undefined) this.nextSeq = Math.max(this.nextSeq, seq);
    const sig: Signal = {
      id: `sig-${s}-${from.slice(0, 8)}`,
      seq: s,
      from,
      to: SELF,
      kind,
      payload,
      callId: "call-1",
      createdAt: 0,
    };
    this.mailbox.push(sig);
    return sig;
  }
  injectOffer(from: string, seq?: number): Signal {
    return this.inject(from, "offer", JSON.stringify({ type: "offer", sdp: `sdp-${from}` }), seq);
  }
  answersTo(peer: string) {
    return this.posted.filter((p) => p.kind === "answer" && p.to === peer);
  }
  offersTo(peer: string) {
    return this.posted.filter((p) => p.kind === "offer" && p.to === peer);
  }
}

// ── Minimal hook harness (no @testing-library dependency) ─────────────────────

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function renderHook(): { result: { current: CallController }; unmount: () => void } {
  const result = { current: null as unknown as CallController };
  function Probe() {
    result.current = useCallController();
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root;
  act(() => {
    root = createRoot(container);
    root.render(<Probe />);
  });
  return {
    result,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/** Advance fake time inside act, flushing effects/microtasks along the way. */
async function tick(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Start the call and run the async join pipeline to completion. */
async function startCall(h: { result: { current: CallController } }) {
  await act(async () => {
    h.result.current.start();
  });
  await tick(0); // engine.start + startCall + mailbox seed resolve
  await tick(0); // syncRoster + drainSignals after the seed
}

let meet: FakeMeet;

beforeEach(() => {
  vi.useFakeTimers();
  FakePC.all = [];
  meet = new FakeMeet();
  H.meet = meet as unknown as Record<string, unknown>;
  H.sse = null;
  H.username = "Fran";
  H.ctx = "ctx1";
  sessionStorage.clear();
  vi.stubGlobal("RTCPeerConnection", FakePC);
  vi.stubGlobal("MediaStream", FakeMediaStream);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn(
        async () => new FakeMediaStream([new FakeTrack("audio"), new FakeTrack("video")]),
      ),
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("joining a call", () => {
  it("acquires media, mints the session, and reports active", async () => {
    const h = renderHook();
    expect(h.result.current.active).toBe(false);

    await startCall(h);

    expect(h.result.current.active).toBe(true);
    expect(h.result.current.joining).toBe(false);
    expect(h.result.current.error).toBeNull();
    expect(h.result.current.callId).toBe("call-1");
    expect(h.result.current.localStream).not.toBeNull();
    expect(meet.counts.startCall).toBe(1);
    h.unmount();
  });

  it("seeds the mailbox head at join — STALE signals never replay into a fresh call", async () => {
    // A previous session left an offer + ice in the mailbox ("won't reconnect
    // after you leave" replay bug). Neither may be fed to the fresh engine.
    meet.injectOffer(PEER);
    meet.inject(PEER, "ice", JSON.stringify({ candidate: "old" }));

    const h = renderHook();
    await startCall(h);
    await tick(2000); // a couple of poll rounds

    expect(meet.answersTo(PEER)).toHaveLength(0);

    // A NEW offer (posted after we joined) is processed normally.
    meet.injectOffer(PEER);
    await tick(1000);
    expect(meet.answersTo(PEER)).toHaveLength(1);
    h.unmount();
  });

  it("retries a failed mailbox seed once before going live", async () => {
    meet.injectOffer(PEER); // stale
    meet.failNext.getSignals = 1; // the seed read errors once

    const h = renderHook();
    await startCall(h);
    await tick(2000);

    // The retry re-seeded correctly: the stale offer still never replayed.
    expect(meet.answersTo(PEER)).toHaveLength(0);
    expect(h.result.current.active).toBe(true);
    h.unmount();
  });

  it("surfaces a join failure (camera denied) as an error, not a wedged 'joining' state", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => {
          throw new Error("Permission denied");
        }),
      },
    });
    const h = renderHook();
    await startCall(h);
    expect(h.result.current.error).toBe("Permission denied");
    expect(h.result.current.joining).toBe(false);
    h.unmount();
  });
});

describe("inbound signal drain (seq collisions & dedupe)", () => {
  it("processes BOTH of two equal-seq signals (concurrent posts on an LWW counter)", async () => {
    const h = renderHook();
    await startCall(h);

    // Two nodes minted the SAME seq concurrently — strict `seq > lastSeq`
    // draining silently dropped the second one and killed its handshake.
    meet.injectOffer(PEER, 7);
    meet.injectOffer(PEER2, 7);
    await tick(1000);

    expect(meet.answersTo(PEER)).toHaveLength(1);
    console.log("POSTED:", JSON.stringify(meet.posted.map(p=>p.kind+">"+p.to)), "mailbox:", JSON.stringify(meet.mailbox.map(s=>s.id+">"+s.to)));
    expect(meet.answersTo(PEER2)).toHaveLength(1);
    h.unmount();
  });

  it("processes an equal-seq twin that gossips in LATE (drain margin + id dedupe)", async () => {
    const h = renderHook();
    await startCall(h);

    meet.injectOffer(PEER, 5);
    await tick(1000);
    expect(meet.answersTo(PEER)).toHaveLength(1);

    // The twin (same seq, other sender) arrives a poll later. Allow a full
    // slow-poll cycle: the cadence check may have sampled before the first
    // drain registered the peer, putting the next drain up to 2s out.
    meet.injectOffer(PEER2, 5);
    await tick(3000);
    expect(meet.answersTo(PEER2)).toHaveLength(1);
    // And the margin re-read did not double-process the first one.
    expect(meet.answersTo(PEER)).toHaveLength(1);
    h.unmount();
  });

  it("drains on an SSE SignalPosted nudge without waiting for the poll", async () => {
    const h = renderHook();
    await startCall(h);
    expect(H.sse).not.toBeNull();

    meet.injectOffer(PEER);
    await act(async () => {
      H.sse!({ contextId: "ctx1", data: { SignalPosted: SELF } });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(meet.answersTo(PEER)).toHaveLength(1);
    h.unmount();
  });
});

describe("outbound signaling reliability", () => {
  it("retries a failed post_signal once (a silently-lost answer killed handshakes)", async () => {
    const h = renderHook();
    await startCall(h);

    meet.failNext.postSignal = 1; // the answer's first post is lost
    meet.injectOffer(PEER);
    await tick(1000);

    expect(meet.answersTo(PEER)).toHaveLength(1); // landed on the retry
    h.unmount();
  });
});

describe("roster reconciliation & self-heal", () => {
  it("creates peers (and tiles) for roster members and tears them down when they leave", async () => {
    const h = renderHook();
    await startCall(h);

    meet.roster = [SELF, PEER];
    meet.members = [presenceRow(SELF, 100), presenceRow(PEER, 100)];
    await tick(1000);
    expect(meet.offersTo(PEER).length).toBeGreaterThanOrEqual(1);
    expect(h.result.current.remotes.map((r) => r.memberId)).toEqual([PEER]);

    // Peer leaves: roster drops them; after the engine's miss-grace the tile goes.
    meet.roster = [SELF];
    await tick(5000);
    expect(h.result.current.remotes).toEqual([]);
    h.unmount();
  });

  it("re-asserts membership via start_call when the contract roster loses US", async () => {
    const h = renderHook();
    await startCall(h);
    expect(meet.counts.startCall).toBe(1);

    // A reap misfire / stale end_call dropped us while we're live in the call.
    meet.roster = [PEER];
    meet.members = [presenceRow(PEER, 100)];
    await tick(1000);
    expect(meet.counts.startCall).toBe(2); // re-asserted

    // Throttled: more roster syncs inside the window must not spam start_call.
    await tick(3000);
    expect(meet.counts.startCall).toBe(2);

    // Past the throttle window (still dropped) it re-asserts again.
    await tick(3000);
    expect(meet.counts.startCall).toBe(3);
    h.unmount();
  });

  it("drops a ghost peer (no sign of life for 60s) even while the roster still lists them", async () => {
    const h = renderHook();
    await startCall(h);

    meet.roster = [SELF, PEER];
    meet.members = [presenceRow(SELF, 100), presenceRow(PEER, 100)];
    await tick(1000);
    expect(h.result.current.remotes.map((r) => r.memberId)).toEqual([PEER]);

    // PEER's presence row freezes and they never signal — after the ghost
    // window the tile must go, no matter what the (stale) roster claims.
    await tick(65_000);
    expect(h.result.current.remotes).toEqual([]);
    h.unmount();
  });

  it("a peer whose presence row keeps MOVING is never ghosted (their clock is irrelevant)", async () => {
    const h = renderHook();
    await startCall(h);

    meet.roster = [SELF, PEER];
    let beat = 0;
    meet.members = [presenceRow(SELF, 100), presenceRow(PEER, 100)];
    const bump = setInterval(() => {
      beat += 1;
      // Their updatedAt values can be ANY numbers (skewed clock) — only change matters.
      meet.members = [presenceRow(SELF, 100), presenceRow(PEER, 100 + beat)];
    }, 3000);

    await tick(90_000);
    expect(h.result.current.remotes.map((r) => r.memberId)).toEqual([PEER]);
    clearInterval(bump);
    h.unmount();
  });
});

describe("leave", () => {
  it("clears the resume marker, tells the contract, and releases media", async () => {
    const h = renderHook();
    await startCall(h);
    expect(sessionStorage.getItem("mm-call-resume")).toBe("ctx1");
    const stream = h.result.current.localStream as unknown as FakeMediaStream;

    await act(async () => {
      await h.result.current.leave();
    });
    await tick(0);

    expect(sessionStorage.getItem("mm-call-resume")).toBeNull();
    expect(meet.counts.leaveCall).toBe(1);
    expect(h.result.current.active).toBe(false);
    expect(h.result.current.localStream).toBeNull();
    for (const t of stream.getTracks()) expect(t.stop).toHaveBeenCalled();
    h.unmount();
  });

  it("says bye to peers on leave so they drop our tile instantly", async () => {
    const h = renderHook();
    await startCall(h);
    meet.roster = [SELF, PEER];
    meet.members = [presenceRow(SELF, 100), presenceRow(PEER, 100)];
    await tick(1000);

    await act(async () => {
      await h.result.current.leave();
    });
    expect(meet.posted.some((p) => p.kind === "bye" && p.to === PEER)).toBe(true);
    h.unmount();
  });

  it("closing the window mid-call (pagehide) still leaves the contract call", async () => {
    const h = renderHook();
    await startCall(h);
    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(meet.counts.leaveCall).toBe(1);
    h.unmount();
  });
});

describe("rejoin & recovery", () => {
  it("a full leave → rejoin starts a clean session that ignores the previous call's signals", async () => {
    const h = renderHook();
    await startCall(h);
    meet.injectOffer(PEER); // in-flight while we leave
    await act(async () => {
      await h.result.current.leave();
    });
    meet.posted.length = 0;

    await startCall(h); // rejoin — must seed past the unconsumed offer
    await tick(2000);
    expect(meet.answersTo(PEER)).toHaveLength(0); // stale offer not replayed
    expect(h.result.current.active).toBe(true);
    expect(meet.counts.startCall).toBe(2);
    h.unmount();
  });

  it("resumes the call automatically after a page refresh (F5 must not dead-end in the lobby)", async () => {
    sessionStorage.setItem("mm-call-resume", "ctx1"); // set by the pre-refresh session
    const h = renderHook();
    await tick(0); // mount effect: join(username) then start
    await tick(0);
    await tick(0);

    expect(meet.counts.join).toBe(1);
    expect(h.result.current.active).toBe(true);
    expect(meet.counts.startCall).toBe(1);
    h.unmount();
  });

  it("does NOT auto-resume in a fresh window (no resume marker)", async () => {
    const h = renderHook();
    await tick(1000);
    expect(h.result.current.active).toBe(false);
    expect(meet.counts.startCall).toBe(0);
    h.unmount();
  });

  it("force reconnect re-asserts membership and re-offers to every peer", async () => {
    const h = renderHook();
    await startCall(h);
    meet.roster = [SELF, PEER];
    meet.members = [presenceRow(SELF, 100), presenceRow(PEER, 100)];
    await tick(1000);
    const offersBefore = meet.offersTo(PEER).length;
    expect(offersBefore).toBeGreaterThanOrEqual(1);

    await act(async () => {
      h.result.current.reconnect();
      await vi.advanceTimersByTimeAsync(0);
    });
    await tick(1000);

    expect(meet.counts.startCall).toBe(2); // membership re-asserted
    expect(meet.offersTo(PEER).length).toBeGreaterThan(offersBefore); // fresh handshake
    h.unmount();
  });

  it("re-announces liveness and membership when the window becomes visible again", async () => {
    const h = renderHook();
    await startCall(h);
    const beats = meet.counts.heartbeat;
    const starts = meet.counts.startCall;

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(meet.counts.heartbeat).toBeGreaterThan(beats);
    expect(meet.counts.startCall).toBeGreaterThan(starts); // idempotent re-add after a reap
    h.unmount();
  });
});

describe("provider-not-ready recovery (the F5 wedge)", () => {
  it("recovers signaling + membership when the provider becomes ready AFTER the call started", async () => {
    // A mid-call refresh flips `active` before the Mero provider finished
    // re-initializing: every early RPC fails. The old code froze that dead
    // client into the engine (posts failed forever) and a "" callId disabled
    // the roster self-heal — the refreshed window sat invisible in the call.
    meet.failNext.startCall = 99; // provider down: all early calls fail
    meet.failNext.getSignals = 99;
    meet.failNext.postSignal = 99;

    const h = renderHook();
    await startCall(h);
    expect(h.result.current.callId).toBeNull(); // join-time start_call failed

    // ~4s later the provider is up. The roster does not list us (our
    // start_call never landed).
    meet.failNext.startCall = 0;
    meet.failNext.getSignals = 0;
    meet.failNext.postSignal = 0;
    meet.roster = [PEER];
    meet.members = [presenceRow(PEER, 100)];

    // Self-heal must re-assert membership (despite callId being "")…
    await tick(6000);
    expect(meet.counts.startCall).toBeGreaterThan(1);
    expect(h.result.current.callId).toBe("call-1");

    // …and the engine must signal through the LIVE client, not the dead
    // snapshot it was built with: an inbound offer gets an answer out.
    meet.roster = [SELF, PEER];
    meet.members = [presenceRow(SELF, 100), presenceRow(PEER, 100)];
    meet.injectOffer(PEER);
    await tick(3000);
    expect(meet.answersTo(PEER).length).toBeGreaterThanOrEqual(1);
    h.unmount();
  });

  it("keeps the 3s heartbeat alive regardless of per-request state churn", async () => {
    // Regression: `meet`'s identity used to change on every RPC (loading flip),
    // restarting the poll effect and resetting the heartbeat interval before it
    // ever fired — nodes received almost NO heartbeats and the reaper starved.
    const h = renderHook();
    await startCall(h);
    const before = meet.counts.heartbeat;
    await tick(30_000);
    expect(meet.counts.heartbeat - before).toBeGreaterThanOrEqual(9);
    h.unmount();
  });
});

describe("one-way media watchdog", () => {
  it("rebuilds a peer that is 'connected' but receives NO media (they'd see us, we'd see black)", async () => {
    const h = renderHook();
    await startCall(h);
    meet.roster = [SELF, PEER];
    meet.members = [presenceRow(SELF, 100), presenceRow(PEER, 100)]; // camera on
    await tick(1000);
    const pc = FakePC.all.find((c) => !c.closed)!;
    pc.setConn("connected");
    // Outbound flows; inbound is flat-zero despite their camera being on.
    pc.statsEntries = [
      { type: "outbound-rtp", bytesSent: 1 },
      { type: "inbound-rtp", bytesReceived: 0 },
    ];
    const grow = setInterval(() => {
      pc.statsEntries[0].bytesSent! += 5000;
    }, 1000);
    const before = FakePC.all.length;

    await tick(25_000); // 4 zero-flow samples @2.5s + poll cadence + cooldown slack
    clearInterval(grow);

    expect(FakePC.all.length).toBeGreaterThan(before); // peer was rebuilt
    expect(pc.closed).toBe(true);
    expect(
      h.result.current.diagnostics.some((d) => d.msg.includes("one-way media")),
    ).toBe(true);
    h.unmount();
  });

  it("does NOT rebuild a silent peer whose mic is muted and camera is off (legitimately idle)", async () => {
    const h = renderHook();
    await startCall(h);
    meet.roster = [SELF, PEER];
    meet.members = [
      presenceRow(SELF, 100),
      presenceRow(PEER, 100, { muted: true, videoOn: false }),
    ];
    await tick(1000);
    const pc = FakePC.all.find((c) => !c.closed)!;
    pc.setConn("connected");
    pc.statsEntries = [
      { type: "outbound-rtp", bytesSent: 1 },
      { type: "inbound-rtp", bytesReceived: 0 }, // silent — but that's expected
    ];
    const grow = setInterval(() => {
      pc.statsEntries[0].bytesSent! += 5000;
    }, 1000);

    await tick(25_000);
    clearInterval(grow);

    expect(pc.closed).toBe(false); // no false-positive rebuild
    h.unmount();
  });
});

describe("presence & heartbeats while in a call", () => {
  it("heartbeats every 3s so the contract reaper knows we're alive", async () => {
    const h = renderHook();
    await startCall(h);
    const before = meet.counts.heartbeat;
    await tick(9500);
    expect(meet.counts.heartbeat - before).toBeGreaterThanOrEqual(3);
    h.unmount();
  });

  it("enriches remote tiles with lobby presence (name, mute, camera)", async () => {
    const h = renderHook();
    await startCall(h);
    meet.roster = [SELF, PEER];
    meet.members = [
      presenceRow(SELF, 100),
      presenceRow(PEER, 100, { username: "Bob", muted: true, videoOn: false }),
    ];
    await tick(1000);

    const bob = h.result.current.remotes.find((r) => r.memberId === PEER);
    expect(bob?.username).toBe("Bob");
    expect(bob?.muted).toBe(true);
    expect(bob?.videoOn).toBe(false);
    h.unmount();
  });
});
