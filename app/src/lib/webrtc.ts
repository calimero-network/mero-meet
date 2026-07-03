// ── CallEngine — the media plane ──────────────────────────────────────────────
//
// A full-mesh WebRTC manager: one RTCPeerConnection per remote peer. It owns
// the camera/mic stream and the peer connections; it does NOT know about
// Calimero. Signaling is delegated to callbacks (`onSignal` out, `handleSignal`
// in) which the call hook wires to the mero-meet contract's post_signal /
// get_signals. This is the seam from RESEARCH-01.md: the contract is the
// (decentralized) signaling channel; the media flows here, peer-to-peer.
//
// Implements MDN's "perfect negotiation" pattern so simultaneous offers (glare)
// resolve deterministically:
//   https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation
//
// In the Tauri desktop webview this uses the system WebRTC stack (real ICE/UDP).
// A bundled TURN relay (shipped by tauri-app) can be injected via setIceServers.

export type SignalKind = "offer" | "answer" | "ice" | "bye";

export interface OutSignal {
  to: string;
  kind: SignalKind;
  payload: string;
}

export type DiagLevel = "info" | "signal" | "peer" | "error";

export interface DiagEntry {
  t: number;
  level: DiagLevel;
  msg: string;
}

/** Per-peer connection snapshot for diagnostics and the media-flow watchdog. */
export interface PeerStat {
  peerId: string;
  connection: RTCPeerConnectionState;
  ice: RTCIceConnectionState;
  outboundKbps: number;
  inboundKbps: number;
  /** Cumulative RTP bytes — safe for multiple concurrent getStats consumers
   *  (the kbps fields share delta state and are only accurate for one). */
  outboundBytes: number;
  inboundBytes: number;
}

export interface CallEngineCallbacks {
  onLocalStream(stream: MediaStream): void;
  onRemoteStream(peerId: string, stream: MediaStream | null): void;
  onSignal(sig: OutSignal): void;
  onPeerStateChange?(peerId: string, state: RTCPeerConnectionState): void;
  /** Developer-mode only: structured diagnostics. Never shown to normal users. */
  onDiag?(entry: DiagEntry): void;
  /**
   * Fetch a fresh ICE server list (e.g. re-mint Cloudflare TURN credentials —
   * they are short-lived, and per Cloudflare's docs must be refreshed via
   * `setConfiguration()` for long sessions). Called before ICE restarts and
   * peer rebuilds; return null to keep the current list.
   */
  getIceServers?(): Promise<RTCIceServer[] | null>;
}

interface PeerState {
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  /** Consecutive roster syncs this peer has been absent from (see syncPeers). */
  missingStreak: number;
  /**
   * True once the current local description has been posted. Candidates
   * gathered before that are bundled into the SDP; the rare straggler that
   * arrives after the gathering cap is trickled individually so it isn't lost.
   */
  sdpSent: boolean;
  /** Armed while the connection is degraded; fires a from-scratch rebuild. */
  rebuildTimer: ReturnType<typeof setTimeout> | null;
  /** MDN perfect negotiation: an inbound offer that lands while we are
   *  applying the peer's ANSWER is not glare — it is the next negotiation. */
  isSettingRemoteAnswerPending: boolean;
  /** Trickled candidates that arrived before the remote description; applying
   *  them early is an error (no ice-ufrag/pwd yet) and dropping them loses
   *  connectivity — they are queued and flushed after setRemoteDescription. */
  pendingCandidates: RTCIceCandidateInit[];
  /** Armed when we post an offer; fires if no answer ever arrives (a lost
   *  signal left the pc in "new"/"connecting" forever — no other recovery
   *  timer covers a connection that never got up in the first place). */
  handshakeTimer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_ICE: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
];

/**
 * How many consecutive roster syncs a peer may be absent before we tear it
 * down. The call roster (call_participants) converges via CRDT gossip, so a
 * peer whose OFFER reached us can easily be missing from our roster view for a
 * few seconds — closing them immediately (the old behaviour) cancelled
 * handshakes mid-flight and connections churned instead of completing.
 */
const ROSTER_MISS_LIMIT = 3;

/**
 * Cap on waiting for ICE gathering before sending an offer/answer. With a
 * STUN+TURN config gathering completes well under this; the cap just ensures a
 * pathological interface list can't stall the handshake.
 */
const ICE_GATHER_TIMEOUT_MS = 2000;

/**
 * If a connection stays degraded (disconnected/failed) this long despite ICE
 * restarts, the RTCPeerConnection is presumed wedged: tear it down and rebuild
 * from scratch (fresh pc, fresh offer/answer). restartIce() reuses transport
 * state that can itself be the problem after a long network drop; a clean
 * rebuild is the reliable reconnect of last resort.
 */
const REBUILD_AFTER_MS = 8000;

/**
 * After a peer says `bye` (or is closed as roster-departed), suppress re-adding
 * them from the roster for this long. The call roster converges via gossip and
 * keeps listing a departed peer for a while — without this, the next roster
 * sync resurrected them, we posted a junk offer to someone who already left,
 * and the grace counter had to close them all over again. A genuine REJOIN
 * clears the suppression instantly: their fresh inbound offer removes the
 * entry (see handleSignal).
 */
const RECENTLY_LEFT_TTL_MS = 20_000;

/**
 * How long a posted OFFER may go unanswered before the peer is rebuilt with a
 * fresh handshake. Signals ride CRDT gossip (seconds, occasionally lost); an
 * unanswered offer used to leave the pc in "new" forever — the degraded-state
 * ladder never fires for a connection that never came up. Politeness-staggered
 * like the rest of recovery so both sides don't rebuild in lockstep.
 */
const HANDSHAKE_TIMEOUT_MS = 12_000;

export class CallEngine {
  private readonly selfId: string;
  private readonly cbs: CallEngineCallbacks;
  private local: MediaStream | null = null;
  private peers = new Map<string, PeerState>();
  private iceServers: RTCIceServer[] = DEFAULT_ICE;
  /** Peers that left (bye / roster-departed) → departure time; see RECENTLY_LEFT_TTL_MS. */
  private recentlyLeft = new Map<string, number>();

  // Previous getStats byte counters, for kbps deltas in the diagnostics panel.
  private prevBytes = new Map<string, { out: number; in: number; t: number }>();

  constructor(selfId: string, cbs: CallEngineCallbacks) {
    this.selfId = selfId;
    this.cbs = cbs;
  }

  private diag(level: DiagLevel, msg: string): void {
    this.cbs.onDiag?.({ t: Date.now(), level, msg });
  }

  /** Inject TURN/STUN servers (e.g. the relay bundled by tauri-app). */
  setIceServers(servers: RTCIceServer[]): void {
    this.iceServers = servers.length ? servers : DEFAULT_ICE;
    this.diag("info", `ice servers: ${servers.map((s) => s.urls).join(", ")}`);
  }

  /**
   * Re-fetch ICE servers before a recovery attempt. TURN credentials
   * (Cloudflare's are short-TTL) can expire mid-call — an ICE restart with
   * the join-time credentials then fails relay allocation forever, which
   * looks like "the call worked and then could never reconnect".
   */
  private async refreshIceServers(): Promise<void> {
    if (!this.cbs.getIceServers) return;
    try {
      const fresh = await this.cbs.getIceServers();
      if (fresh && fresh.length) this.iceServers = fresh;
    } catch {
      /* keep the current list */
    }
  }

  /** MDN-recommended restart sequence: setConfiguration(fresh) → restartIce(). */
  private restartIceFresh(peerId: string, state: PeerState): void {
    void this.refreshIceServers().then(() => {
      if (this.peers.get(peerId) !== state) return; // rebuilt/left meanwhile
      try {
        state.pc.setConfiguration({ iceServers: this.iceServers });
      } catch {
        /* some webviews reject mid-call config changes — restart anyway */
      }
      try {
        state.pc.restartIce();
      } catch {
        /* pc may be closing */
      }
    });
  }

  /**
   * Watchdog for an offer that never gets an answer (lost over the gossip
   * channel). If the signaling state is still "have-local-offer" when it
   * fires — no answer applied, no glare rollback — rebuild from scratch,
   * which re-mints TURN creds and re-offers. The polite side waits 2× so the
   * two sides never rebuild in lockstep.
   */
  private armHandshakeTimer(peerId: string, state: PeerState): void {
    if (state.handshakeTimer) clearTimeout(state.handshakeTimer);
    const wait = state.polite ? HANDSHAKE_TIMEOUT_MS * 2 : HANDSHAKE_TIMEOUT_MS;
    state.handshakeTimer = setTimeout(() => {
      state.handshakeTimer = null;
      if (this.peers.get(peerId) !== state) return; // rebuilt/left meanwhile
      const conn = state.pc.connectionState;
      if (conn === "connected") return;
      // Mid-handshake states that ARE progressing get covered by either the
      // degraded-state ladder (connecting → failed) or the peer's own side;
      // we fire on the two stuck shapes: an unanswered local offer, or a pc
      // that never negotiated at all (no descriptions in either direction).
      const stuckOffer = state.pc.signalingState === "have-local-offer";
      const neverNegotiated =
        state.pc.signalingState === "stable" &&
        !state.pc.remoteDescription &&
        !state.makingOffer &&
        conn !== "connecting";
      if (!stuckOffer && !neverNegotiated) return;
      this.diag(
        "peer",
        `${peerId.slice(0, 8)} handshake dead after ${wait / 1000}s (${stuckOffer ? "offer unanswered" : "never negotiated"}) — rebuilding`,
      );
      this.closePeer(peerId, "handshake timeout", true);
      void this.refreshIceServers().then(() => {
        if (!this.peers.has(peerId)) this.addPeer(peerId);
      });
    }, wait);
  }

  /**
   * Developer-mode only: snapshot each peer connection (state + throughput).
   * Pulled on an interval by the diagnostics overlay; no effect on the call.
   */
  async getStats(): Promise<PeerStat[]> {
    const out: PeerStat[] = [];
    for (const [peerId, { pc }] of this.peers) {
      let bytesOut = 0;
      let bytesIn = 0;
      try {
        const report = await pc.getStats();
        report.forEach((s) => {
          if (s.type === "outbound-rtp") bytesOut += (s as { bytesSent?: number }).bytesSent ?? 0;
          if (s.type === "inbound-rtp") bytesIn += (s as { bytesReceived?: number }).bytesReceived ?? 0;
        });
      } catch {
        /* getStats may reject while connecting */
      }
      const now = Date.now();
      const prev = this.prevBytes.get(peerId);
      const dt = prev ? (now - prev.t) / 1000 : 0;
      const outKbps = prev && dt > 0 ? ((bytesOut - prev.out) * 8) / 1000 / dt : 0;
      const inKbps = prev && dt > 0 ? ((bytesIn - prev.in) * 8) / 1000 / dt : 0;
      this.prevBytes.set(peerId, { out: bytesOut, in: bytesIn, t: now });
      out.push({
        peerId,
        connection: pc.connectionState,
        ice: pc.iceConnectionState,
        outboundKbps: Math.max(0, Math.round(outKbps)),
        inboundKbps: Math.max(0, Math.round(inKbps)),
        outboundBytes: bytesOut,
        inboundBytes: bytesIn,
      });
    }
    return out;
  }

  /** Acquire camera + mic and publish the local stream. */
  async start(): Promise<MediaStream> {
    if (this.local) return this.local;
    this.local = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
    const v = this.local.getVideoTracks()[0]?.getSettings();
    this.diag(
      "info",
      `local media acquired — cam ${v?.width ?? "?"}×${v?.height ?? "?"}@${Math.round(v?.frameRate ?? 0)}fps, mic ${this.local.getAudioTracks().length ? "on" : "none"}`,
    );
    // Belt-and-braces for the media/peer race: a peer created BEFORE this
    // point (an inbound offer, or a roster sync that slipped through) has no
    // outbound tracks — it would answer/connect but stream NOTHING, leaving
    // the other side a black tile. Publish to any track-less pc now; addTrack
    // schedules negotiationneeded, so they renegotiate with media attached.
    for (const [id, { pc }] of this.peers) {
      if (pc.getSenders().some((s) => s.track)) continue;
      this.diag("peer", `publishing local tracks to ${id.slice(0, 8)} (media raced the peer)`);
      this.local.getTracks().forEach((t) => pc.addTrack(t, this.local!));
    }
    this.cbs.onLocalStream(this.local);
    return this.local;
  }

  /** Toggle the local mic. Returns the new muted state. */
  setMuted(muted: boolean): void {
    this.local?.getAudioTracks().forEach((t) => (t.enabled = !muted));
  }

  /** Toggle the local camera. */
  setVideo(on: boolean): void {
    this.local?.getVideoTracks().forEach((t) => (t.enabled = on));
  }

  /**
   * Reconcile the peer set against the call roster. New peers get a connection
   * (which kicks off negotiation). Departed peers are torn down only after
   * being absent for {@link ROSTER_MISS_LIMIT} consecutive syncs: our roster
   * view converges via CRDT gossip and routinely lags a peer's own join (their
   * offer often arrives first), so an immediate close would cancel handshakes
   * mid-flight. A `bye` signal still closes instantly (see handleSignal).
   */
  syncPeers(roster: string[]): void {
    const wanted = new Set(roster.filter((id) => id !== this.selfId));
    for (const id of wanted) {
      const existing = this.peers.get(id);
      if (existing) {
        existing.missingStreak = 0;
        continue;
      }
      // Don't resurrect a peer we just saw leave: the roster keeps listing
      // them until gossip catches up. Their own rejoin offer bypasses this.
      const leftAt = this.recentlyLeft.get(id);
      if (leftAt !== undefined) {
        if (Date.now() - leftAt < RECENTLY_LEFT_TTL_MS) continue;
        this.recentlyLeft.delete(id);
      }
      this.addPeer(id);
    }
    for (const [id, state] of [...this.peers.entries()]) {
      if (wanted.has(id)) continue;
      // Connected media outranks the roster: a peer can vanish from
      // call_participants while their media is demonstrably flowing (their
      // window was minimized → timers suspended → heartbeats stopped → the
      // contract reaped them). Keep the connection; `bye` or a real
      // connection failure still tears it down. missingStreak = -1 marks
      // "roster-absent but connected" so this logs once, not per sync.
      if (state.pc.connectionState === "connected") {
        if (state.missingStreak !== -1) {
          state.missingStreak = -1;
          this.diag("peer", `${id.slice(0, 8)} left roster but media is connected — keeping`);
        }
        continue;
      }
      if (state.missingStreak < 0) state.missingStreak = 0;
      state.missingStreak += 1;
      if (state.missingStreak >= ROSTER_MISS_LIMIT) {
        this.closePeer(id, "left roster");
      } else {
        this.diag("peer", `${id.slice(0, 8)} missing from roster (${state.missingStreak}/${ROSTER_MISS_LIMIT})`);
      }
    }
  }

  /**
   * Wait until ICE gathering finishes (or the cap elapses) so the local
   * description carries ALL candidates inline — non-trickle ICE.
   *
   * Our signaling channel is a CRDT contract replicated over gossip: every
   * message costs a contract write plus node-to-node propagation (seconds, not
   * milliseconds). Trickled candidates meant ~10 extra writes per peer racing
   * the offer they belong to. Bundling makes the whole handshake exactly two
   * messages (offer → answer), which is dramatically faster AND more reliable
   * over this transport.
   */
  private waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, ICE_GATHER_TIMEOUT_MS);
      function done() {
        clearTimeout(timer);
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      }
      function check() {
        if (pc.iceGatheringState === "complete") done();
      }
      pc.addEventListener("icegatheringstatechange", check);
    });
  }

  private addPeer(peerId: string): PeerState {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    // Politeness must differ across a pair; a string compare is deterministic
    // and symmetric, so exactly one side is polite.
    const state: PeerState = {
      pc,
      polite: this.selfId > peerId,
      makingOffer: false,
      ignoreOffer: false,
      missingStreak: 0,
      sdpSent: false,
      rebuildTimer: null,
      isSettingRemoteAnswerPending: false,
      pendingCandidates: [],
      handshakeTimer: null,
    };
    this.peers.set(peerId, state);
    this.recentlyLeft.delete(peerId); // any add is authoritative (e.g. a rejoin offer)
    this.diag("peer", `+ peer ${peerId.slice(0, 8)} (polite=${state.polite})`);
    // Surface the initial state immediately: the adaptive fast-poll upstream
    // keys off "any peer not yet connected", and the first real
    // connectionstatechange only fires once the answer is already back.
    this.cbs.onPeerStateChange?.(peerId, pc.connectionState);

    // Handshake watchdog from birth: a peer that never gets to negotiate at
    // all (negotiationneeded threw, our offer OR their answer lost in gossip)
    // sits in "new" forever — no disconnected/failed event will ever fire.
    this.armHandshakeTimer(peerId, state);

    // Publish our tracks — this schedules `negotiationneeded`.
    this.local?.getTracks().forEach((track) => pc.addTrack(track, this.local!));

    pc.ontrack = (e) => this.cbs.onRemoteStream(peerId, e.streams[0] ?? null);

    // Candidates gathered before the SDP is posted ride inside it (non-trickle,
    // see waitForIceGathering). Only a straggler past the gathering cap is
    // trickled individually, so slow TURN allocations still make it across.
    pc.onicecandidate = ({ candidate }) => {
      if (candidate && state.sdpSent) {
        this.diag("signal", `→ ice ${peerId.slice(0, 8)} (late)`);
        this.cbs.onSignal({
          to: peerId,
          kind: "ice",
          payload: JSON.stringify(candidate),
        });
      }
    };

    pc.onnegotiationneeded = async () => {
      try {
        state.makingOffer = true;
        state.sdpSent = false;
        await pc.setLocalDescription();
        await this.waitForIceGathering(pc);
        if (pc.localDescription) {
          this.diag("signal", `→ offer ${peerId.slice(0, 8)} (ice bundled)`);
          this.cbs.onSignal({
            to: peerId,
            kind: "offer",
            payload: JSON.stringify(pc.localDescription),
          });
          state.sdpSent = true;
          this.armHandshakeTimer(peerId, state);
        }
      } catch (err) {
        // Surface it — a silently-swallowed negotiation failure left a fresh
        // pc wedged in "new" with no offer ever sent (seen live after a
        // rebuild). The handshake watchdog armed below rebuilds it.
        this.diag("error", `negotiation with ${peerId.slice(0, 8)} failed: ${err instanceof Error ? err.message : err}`);
      } finally {
        state.makingOffer = false;
      }
    };

    pc.onconnectionstatechange = () => {
      this.diag("peer", `${peerId.slice(0, 8)} → ${pc.connectionState}`);
      this.cbs.onPeerStateChange?.(peerId, pc.connectionState);
      const st = pc.connectionState;

      if (st === "connected") {
        // Healed — stand down the rebuild and handshake watchdogs.
        state.missingStreak = 0;
        if (state.rebuildTimer) {
          clearTimeout(state.rebuildTimer);
          state.rebuildTimer = null;
        }
        if (state.handshakeTimer) {
          clearTimeout(state.handshakeTimer);
          state.handshakeTimer = null;
        }
        return;
      }

      // Recovery ladder for degraded connections:
      //  1. "failed" → ICE restart; "disconnected" often self-heals, so it
      //     gets a short fuse before the restart.
      //  2. If still degraded after the rebuild window, the pc is presumed
      //     wedged (a ghost/half-dead transport): rebuild the peer from
      //     scratch, which runs a brand-new offer/answer handshake.
      //
      // The ladder is ASYMMETRIC by politeness: the impolite side leads
      // recovery, the polite side hangs back ~2× as a backstop. Both sides
      // recovering in lockstep livelocked over our seconds-slow signaling
      // channel — each side's restart re-offered and invalidated the answer
      // the other side had just posted, every ~20s, forever ("failed →
      // restarting ICE" loops on BOTH peers while nothing ever connected).
      const lead = !state.polite;
      if (st === "failed") {
        const fuse = lead ? 0 : 5000;
        const restart = () => {
          if (this.peers.get(peerId) !== state || pc.connectionState !== "failed") return;
          this.diag("peer", `${peerId.slice(0, 8)} failed → restarting ICE${lead ? "" : " (backstop)"}`);
          this.restartIceFresh(peerId, state);
        };
        if (fuse === 0) restart();
        else setTimeout(restart, fuse);
      } else if (st === "disconnected") {
        setTimeout(() => {
          if (this.peers.get(peerId) === state && pc.connectionState === "disconnected") {
            this.diag("peer", `${peerId.slice(0, 8)} still disconnected → restarting ICE`);
            this.restartIceFresh(peerId, state);
          }
        }, lead ? 2500 : 6000);
      }
      if ((st === "failed" || st === "disconnected") && !state.rebuildTimer) {
        const rebuildAfter = lead ? REBUILD_AFTER_MS : REBUILD_AFTER_MS * 2;
        state.rebuildTimer = setTimeout(() => {
          state.rebuildTimer = null;
          if (this.peers.get(peerId) !== state) return; // already rebuilt/left
          const cur = pc.connectionState;
          if (cur !== "failed" && cur !== "disconnected") return; // healed/healing
          this.diag(
            "peer",
            `${peerId.slice(0, 8)} unreachable for ${rebuildAfter / 1000}s — rebuilding connection from scratch`,
          );
          // keepStream: leave the last frame on the tile under "reconnecting…".
          this.closePeer(peerId, "rebuilding", true);
          void this.refreshIceServers().then(() => this.addPeer(peerId));
        }, rebuildAfter);
      }
    };

    return state;
  }

  /**
   * Swap the published video track on every peer (and the local stream) without
   * renegotiating — used to turn camera background effects on/off mid-call.
   * `replaceTrack` is transparent to the remote peer (no new SDP).
   */
  async replaceVideoTrack(track: MediaStreamTrack | null): Promise<void> {
    // Update the local stream we expose to the UI. Hand the UI a NEW
    // MediaStream instance: React state compares by reference (the same object
    // would skip the re-render entirely) and WebKit does not reliably refresh a
    // <video> whose srcObject had tracks swapped in place — both made the local
    // preview keep showing the raw camera after enabling blur.
    if (this.local) {
      this.local.getVideoTracks().forEach((t) => this.local!.removeTrack(t));
      if (track) this.local.addTrack(track);
      this.local = new MediaStream(this.local.getTracks());
      this.cbs.onLocalStream(this.local);
    }
    // Update each peer's outbound video sender in place.
    for (const { pc } of this.peers.values()) {
      const sender = pc.getSenders().find((s) => s.track?.kind === "video");
      if (sender) {
        try {
          await sender.replaceTrack(track);
        } catch {
          /* sender may be gone if the peer just left */
        }
      }
    }
    this.diag("info", `published video track swapped (${track ? track.label || "processed" : "none"})`);
  }

  /** The live local media stream (raw camera + mic), if started. */
  getLocalStream(): MediaStream | null {
    return this.local;
  }

  /** Feed an inbound signaling message from `from`. */
  async handleSignal(from: string, kind: string, payload: string): Promise<void> {
    this.diag("signal", `← ${kind} ${from.slice(0, 8)}`);
    if (kind === "bye") {
      // Remember the departure so the (gossip-stale) roster can't resurrect
      // them; their own rejoin offer clears this via addPeer.
      this.recentlyLeft.set(from, Date.now());
      this.closePeer(from, "bye");
      return;
    }
    const state = this.peers.get(from) ?? this.addPeer(from);
    const { pc } = state;

    try {
      if (kind === "offer" || kind === "answer") {
        const desc = JSON.parse(payload) as RTCSessionDescriptionInit;
        // MDN perfect negotiation: an offer landing while we are applying the
        // peer's ANSWER is the next negotiation round, not glare.
        const readyForOffer =
          !state.makingOffer &&
          (pc.signalingState === "stable" || state.isSettingRemoteAnswerPending);
        const offerCollision = desc.type === "offer" && !readyForOffer;
        state.ignoreOffer = !state.polite && offerCollision;
        if (state.ignoreOffer) return;

        state.isSettingRemoteAnswerPending = desc.type === "answer";
        try {
          await pc.setRemoteDescription(desc);
        } catch (err) {
          state.isSettingRemoteAnswerPending = false;
          if (desc.type === "offer" && offerCollision && state.polite) {
            // WKWebView (the desktop webview) does not implement the implicit
            // rollback the modern pattern relies on — glare THROWS here and
            // used to be swallowed, silently killing the handshake. Fall back
            // to an explicit rollback; if even that fails, rebuild the peer.
            try {
              await pc.setLocalDescription({ type: "rollback" } as RTCSessionDescriptionInit);
              await pc.setRemoteDescription(desc);
              this.diag("peer", `${from.slice(0, 8)} glare resolved via explicit rollback`);
            } catch {
              this.diag("peer", `${from.slice(0, 8)} rollback unsupported — rebuilding to resolve glare`);
              this.rebuildPeer(from, "glare (no rollback support)");
              return;
            }
          } else {
            throw err;
          }
        }
        state.isSettingRemoteAnswerPending = false;
        // An applied description answers/settles our outstanding offer.
        if (state.handshakeTimer) {
          clearTimeout(state.handshakeTimer);
          state.handshakeTimer = null;
        }
        // Trickled candidates that raced this description can be applied now.
        if (state.pendingCandidates.length) {
          const queued = state.pendingCandidates;
          state.pendingCandidates = [];
          for (const c of queued) {
            try {
              await pc.addIceCandidate(c);
            } catch {
              /* stale generation — safe to drop after a restart */
            }
          }
        }
        if (desc.type === "offer") {
          state.sdpSent = false;
          await pc.setLocalDescription();
          await this.waitForIceGathering(pc);
          if (pc.localDescription) {
            this.diag("signal", `→ answer ${from.slice(0, 8)} (ice bundled)`);
            this.cbs.onSignal({
              to: from,
              kind: "answer",
              payload: JSON.stringify(pc.localDescription),
            });
            state.sdpSent = true;
          }
        }
      } else if (kind === "ice") {
        const candidate = JSON.parse(payload) as RTCIceCandidateInit;
        if (!pc.remoteDescription) {
          // Applying a candidate before the remote description is an error
          // (no ice-ufrag/pwd to match it against) and dropping it can cost
          // the only working path — queue until the description lands.
          state.pendingCandidates.push(candidate);
          return;
        }
        try {
          await pc.addIceCandidate(candidate);
        } catch (err) {
          if (!state.ignoreOffer) throw err;
        }
      }
    } catch {
      /* drop malformed / out-of-order signal; ICE will recover */
    }
  }

  /**
   * Tear down a peer connection. `keepStream` (rebuild path) skips the
   * stream-cleared callback so the UI keeps the last frame under its
   * "reconnecting…" overlay instead of flashing the tile empty — the rebuilt
   * connection's ontrack replaces the stream when media resumes.
   */
  private closePeer(peerId: string, reason = "", keepStream = false): void {
    const state = this.peers.get(peerId);
    if (!state) return;
    if (state.rebuildTimer) {
      clearTimeout(state.rebuildTimer);
      state.rebuildTimer = null;
    }
    if (state.handshakeTimer) {
      clearTimeout(state.handshakeTimer);
      state.handshakeTimer = null;
    }
    state.pc.onicecandidate = null;
    state.pc.ontrack = null;
    state.pc.onnegotiationneeded = null;
    state.pc.onconnectionstatechange = null;
    state.pc.close();
    this.peers.delete(peerId);
    this.diag("peer", `- peer ${peerId.slice(0, 8)}${reason ? ` (${reason})` : ""}`);
    if (!keepStream) this.cbs.onRemoteStream(peerId, null);
  }

  /**
   * Rebuild ONE peer from scratch (fresh pc + fresh TURN credentials + a new
   * offer/answer handshake), keeping the tile's last frame. Used by the
   * one-way-media watchdog: a connection can report "connected" while RTP
   * flows in only one direction (asymmetric NAT/relay failure) — one side
   * sees both cameras, the other sees only themselves.
   */
  rebuildPeer(peerId: string, reason = "one-way media"): void {
    if (!this.peers.has(peerId)) return;
    this.diag("peer", `${peerId.slice(0, 8)} rebuild requested (${reason})`);
    this.closePeer(peerId, reason, true);
    void this.refreshIceServers().then(() => {
      if (!this.peers.has(peerId)) this.addPeer(peerId);
    });
  }

  /**
   * Manual force-reconnect: tear down and re-negotiate EVERY peer connection
   * from scratch (fresh pc, fresh offer/answer). Streams are kept on the
   * tiles under "reconnecting…" until the rebuilt connection's ontrack
   * replaces them. Also clears the recently-left suppression, so the next
   * roster sync may re-add peers we previously wrote off.
   */
  rebuildAll(): void {
    const ids = [...this.peers.keys()];
    this.diag("info", `force reconnect — rebuilding ${ids.length} peer connection(s)`);
    this.recentlyLeft.clear();
    for (const id of ids) this.closePeer(id, "force reconnect", true);
    void this.refreshIceServers().then(() => {
      for (const id of ids) if (!this.peers.has(id)) this.addPeer(id);
    });
  }

  /** Announce departure to peers and tear everything down. */
  stop(): void {
    this.diag("info", `stopping call — saying bye to ${this.peers.size} peer(s)`);
    for (const peerId of this.peers.keys()) {
      this.cbs.onSignal({ to: peerId, kind: "bye", payload: "" });
    }
    for (const peerId of [...this.peers.keys()]) this.closePeer(peerId, "call ended");
    this.local?.getTracks().forEach((t) => t.stop());
    this.local = null;
  }
}
