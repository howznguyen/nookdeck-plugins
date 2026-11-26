/**
 * OBS Studio through its built-in WebSocket server (obs-websocket v5, OBS 28+).
 * Hello (op 0) -> Identify (op 1, sha256 challenge auth) -> Identified (op 2); then a snapshot (scenes, record, stream, virtual camera,
 * audio inputs, scene items), events (op 5) keep it current, requests (op 6/7) run the actions. Reconnects with back-off. The password
 * is only used for the Identify hash and is never logged.
 */
import { createHash } from "node:crypto";

/** What ctx.net.websocket gives (the agent opens the socket and checks the address). */
export interface Socket {
  send(text: string): void;
  onMessage(fn: (text: string) => void): void;
  onClose(fn: (code: number, reason: string) => void): void;
  close(): void;
}
export type Opener = (url: string, protocols: string[]) => Promise<Socket>;

/** Why OBS is not connected. */
export type ObsError = "unreachable" | "auth" | "no-password" | "version" | "not-allowed";

export interface ObsConfig { host: string; port: number; password: string }

export interface ObsState {
  connected: boolean;
  error?: ObsError;
  scene?: string;
  /** In OBS's own on-screen order (top first). */
  scenes: string[];
  record: { active: boolean; paused: boolean; startedAt?: number };
  stream: { active: boolean; startedAt?: number };
  virtualcam: boolean;
  /** Audio inputs only. */
  inputs: Record<string, { muted: boolean }>;
  /** "<scene>/<source>" -> visible */
  items: Record<string, boolean>;
}

export interface ObsOptions {
  open: Opener;
  config: () => ObsConfig;
  /** Called after every change (coalesced per tick). */
  onChange: (s: ObsState) => void;
  log?: (...a: unknown[]) => void;
  /** Reconnect delays in ms; the last one repeats. The default finds a restarted OBS within 10 s. */
  backoffMs?: number[];
  /** How long to wait for Hello, and then for Identified. */
  helloMs?: number;
  requestMs?: number;
  now?: () => number;
}

/** obs-websocket v5 authentication string: base64(sha256(base64(sha256(password + salt)) + challenge)). */
export function obsAuth(password: string, salt: string, challenge: string): string {
  const secret = createHash("sha256").update(password + salt).digest("base64");
  return createHash("sha256").update(secret + challenge).digest("base64");
}

// EventSubscription bits: General 1, Scenes 4, Inputs 8, Outputs 64, SceneItems 128
export const OBS_EVENTS = 1 | 4 | 8 | 64 | 128;
const CLOSE_AUTH = 4009, CLOSE_VERSION = 4010;
export const NOT_CONNECTED = "OBS is not connected";

const empty = (): Omit<ObsState, "connected" | "error"> => ({ scenes: [], record: { active: false, paused: false }, stream: { active: false }, virtualcam: false, inputs: {}, items: {} });

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

/** `[::1]` style for an IPv6 host in a URL. */
export const wsUrl = (c: { host: string; port: number }): string => `ws://${c.host.includes(":") && !c.host.startsWith("[") ? `[${c.host}]` : c.host}:${c.port}`;

export class Obs {
  private ws: Socket | null = null;
  private ready = false;
  /** the snapshot after Identified is in: before that the state is partial, so it is not shown as connected */
  private synced = false;
  private err: ObsError | undefined;
  private gen = 0;
  private seq = 1;
  private pending = new Map<string, Pending>();
  private st = empty();
  private itemIds = new Map<string, number>(); // "<scene>/<source>" -> sceneItemId
  private itemKeys = new Map<string, string>(); // "<scene>#<id>" -> "<scene>/<source>"
  private attempt = 0;
  private phaseTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private queued = false;

  constructor(private o: ObsOptions) {}
  private now() { return (this.o.now ?? Date.now)(); }

  connected(): boolean { return this.ready && this.synced; }
  error(): ObsError | undefined { return this.err; }

  state(): ObsState {
    const live = this.connected();
    const s = this.st;
    if (!live) return { connected: false, ...(this.err ? { error: this.err } : {}), ...empty() };
    return {
      connected: true, ...(s.scene !== undefined ? { scene: s.scene } : {}), scenes: [...s.scenes],
      record: { ...s.record }, stream: { ...s.stream }, virtualcam: s.virtualcam,
      inputs: Object.fromEntries(Object.entries(s.inputs).map(([k, v]) => [k, { ...v }])), items: { ...s.items },
    };
  }

  /** Waits until connected, for at most `ms`; true when it is. */
  async whenConnected(ms: number): Promise<boolean> {
    const end = Date.now() + ms;
    while (!this.connected() && Date.now() < end && !this.stopped && !(this.err && this.err !== "unreachable")) await new Promise((r) => setTimeout(r, 25));
    return this.connected();
  }

  private changed() {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => { this.queued = false; this.o.onChange(this.state()); });
  }

  // ---- lifecycle ----
  start() { this.stopped = false; void this.open(); }
  stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.teardown();
  }
  /** The settings changed: connect again now with them. */
  restart() {
    this.err = undefined;
    this.attempt = 0;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.teardown();
    this.changed();
    if (!this.stopped) void this.open();
  }

  private teardown() {
    const was = this.connected();
    this.ready = false;
    this.synced = false;
    this.gen++;
    if (this.phaseTimer) clearTimeout(this.phaseTimer);
    this.phaseTimer = undefined;
    const ws = this.ws;
    this.ws = null;
    if (ws) { try { ws.close(); } catch { /* closed */ } }
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(NOT_CONNECTED)); this.pending.delete(id); }
    this.st = empty();
    this.itemIds.clear(); this.itemKeys.clear();
    if (was) this.changed();
  }

  private async open() {
    if (this.stopped || this.ws) return;
    const gen = ++this.gen;
    const c = this.o.config();
    let ws: Socket;
    try { ws = await this.o.open(wsUrl(c), ["obswebsocket.json"]); }
    catch (e: any) {
      if (gen !== this.gen) return;
      // a host or port that the plugin's permissions do not list: retrying does not help
      return this.fail(e?.permission === "network" ? "not-allowed" : "unreachable");
    }
    if (gen !== this.gen || this.stopped) { try { ws.close(); } catch { /* closed */ } return; }
    this.ws = ws;
    // no Hello in time: OBS is still starting (or something else listens there); retried like a closed port
    this.phase(gen);
    ws.onMessage((t) => { if (gen === this.gen) void this.onMessage(ws, t, gen); });
    ws.onClose((code) => {
      if (this.ws !== ws || gen !== this.gen) return;
      this.ws = null;
      if (code === CLOSE_AUTH) return this.fail("auth");
      if (code === CLOSE_VERSION) return this.fail("version");
      this.fail("unreachable");
    });
  }

  private phase(gen: number) {
    if (this.phaseTimer) clearTimeout(this.phaseTimer);
    this.phaseTimer = setTimeout(() => { if (gen === this.gen && !this.ready) this.fail("unreachable"); }, this.o.helloMs ?? 5000);
  }

  private fail(why: ObsError) {
    const before = this.err;
    this.err = why;
    this.teardown();
    if (before !== why) this.changed();
    // a wrong password, a missing one, an old OBS or an address that is not allowed do not get better by retrying: new settings restart it
    if (this.stopped || why !== "unreachable") return;
    const d = this.o.backoffMs ?? [1000, 2000, 3000, 5000];
    const wait = d[Math.min(this.attempt++, d.length - 1)]!;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { this.retryTimer = undefined; void this.open(); }, wait);
  }

  private send(ws: Socket, op: number, d: unknown) { ws.send(JSON.stringify({ op, d })); }

  private async onMessage(ws: Socket, raw: string, gen: number) {
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== "object") return;
    const d = m.d ?? {};
    switch (m.op) {
      case 0: { // Hello
        if (typeof d.rpcVersion !== "number" || d.rpcVersion < 1) return this.fail("version");
        const ident: Record<string, unknown> = { rpcVersion: 1, eventSubscriptions: OBS_EVENTS };
        if (d.authentication && typeof d.authentication.challenge === "string" && typeof d.authentication.salt === "string") {
          const pw = this.o.config().password;
          if (!pw) return this.fail("no-password");
          ident.authentication = obsAuth(pw, d.authentication.salt, d.authentication.challenge);
        }
        this.send(ws, 1, ident);
        this.phase(gen);
        return;
      }
      case 2: { // Identified
        if (this.phaseTimer) clearTimeout(this.phaseTimer);
        this.phaseTimer = undefined;
        this.ready = true;
        this.err = undefined;
        this.attempt = 0;
        try { await this.snapshot(); } catch (e) { this.o.log?.("snapshot incomplete:", (e as Error)?.message); }
        if (gen !== this.gen) return;
        this.synced = true;
        this.changed();
        return;
      }
      case 5: this.onEvent(String(d.eventType ?? ""), d.eventData ?? {}); return;
      case 7: { // RequestResponse
        const p = this.pending.get(String(d.requestId));
        if (!p) return;
        this.pending.delete(String(d.requestId));
        clearTimeout(p.timer);
        if (d.requestStatus?.result) p.resolve(d.responseData ?? {});
        else p.reject(new Error(`OBS: ${String(d.requestStatus?.comment ?? d.requestStatus?.code ?? "error").slice(0, 160)}`));
        return;
      }
    }
  }

  /** One request to OBS (op 6). */
  request<T = any>(requestType: string, requestData?: Record<string, unknown>): Promise<T> {
    const ws = this.ws;
    if (!this.ready || !ws) return Promise.reject(new Error(NOT_CONNECTED));
    const requestId = `nd${this.seq++}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error("OBS did not answer")); }, this.o.requestMs ?? 5000);
      this.pending.set(requestId, { resolve, reject, timer });
      this.send(ws, 6, { requestType, requestId, ...(requestData ? { requestData } : {}) });
    });
  }

  // ---- snapshot ----
  private since(durationMs: unknown): number {
    return typeof durationMs === "number" && durationMs >= 0 ? this.now() - Math.round(durationMs) : this.now();
  }

  private async snapshot() {
    const [scenes, rec, str, vcam] = await Promise.all([
      this.request("GetSceneList"),
      this.request("GetRecordStatus"),
      this.request("GetStreamStatus"),
      this.request("GetVirtualCamStatus").catch(() => ({ outputActive: false })),
    ]);
    this.applyScenes(scenes);
    this.st.record = { active: !!rec.outputActive, paused: !!rec.outputPaused, ...(rec.outputActive ? { startedAt: this.since(rec.outputDuration) } : {}) };
    this.st.stream = { active: !!str.outputActive, ...(str.outputActive ? { startedAt: this.since(str.outputDuration) } : {}) };
    this.st.virtualcam = !!vcam.outputActive;
    await Promise.all([this.loadInputs(), this.loadItems()]);
  }

  private applyScenes(r: any) {
    const raw: any[] = Array.isArray(r?.scenes) ? r.scenes.filter((x: any) => typeof x?.sceneName === "string") : [];
    // OBS lists scenes bottom-up (the last in its list is index 0): show them in OBS's on-screen order
    raw.sort((a, b) => (Number(b.sceneIndex) || 0) - (Number(a.sceneIndex) || 0));
    this.st.scenes = raw.map((x) => x.sceneName as string);
    if (typeof r?.currentProgramSceneName === "string") this.st.scene = r.currentProgramSceneName;
  }

  /** Audio inputs: every input whose mute state OBS can read. */
  private async loadInputs() {
    const r = await this.request("GetInputList");
    const names: string[] = Array.isArray(r?.inputs) ? r.inputs.map((x: any) => x?.inputName).filter((x: any) => typeof x === "string") : [];
    const inputs: ObsState["inputs"] = {};
    await Promise.all(names.map((n) => this.request("GetInputMute", { inputName: n }).then((m) => { inputs[n] = { muted: !!m.inputMuted }; }, () => { /* not an audio input */ })));
    this.st.inputs = inputs;
  }

  private async loadItems(only?: string) {
    const scenes = only ? [only] : this.st.scenes;
    if (!only) { this.st.items = {}; this.itemIds.clear(); this.itemKeys.clear(); }
    else for (const k of Object.keys(this.st.items)) if (k.startsWith(`${only}/`)) { delete this.st.items[k]; this.itemIds.delete(k); }
    await Promise.all(scenes.map((scene) => this.request("GetSceneItemList", { sceneName: scene }).then((r) => {
      for (const it of Array.isArray(r?.sceneItems) ? r.sceneItems : []) {
        if (typeof it?.sourceName !== "string" || typeof it?.sceneItemId !== "number") continue;
        const key = `${scene}/${it.sourceName}`;
        this.st.items[key] = !!it.sceneItemEnabled;
        this.itemIds.set(key, it.sceneItemId);
        this.itemKeys.set(`${scene}#${it.sceneItemId}`, key);
      }
    }, () => {})));
  }

  // ---- events ----
  private onEvent(type: string, e: any) {
    if (!this.ready) return;
    const s = this.st;
    const later = (p: Promise<unknown>) => void p.then(() => this.changed(), () => {});
    switch (type) {
      case "CurrentProgramSceneChanged": if (typeof e.sceneName === "string") s.scene = e.sceneName; break;
      case "SceneListChanged": this.applyScenes({ scenes: e.scenes, currentProgramSceneName: s.scene }); later(this.loadItems()); break;
      case "SceneCreated": case "SceneRemoved": case "SceneNameChanged":
        return later(this.request("GetSceneList").then((r) => { this.applyScenes(r); return this.loadItems(); }));
      case "RecordStateChanged": {
        const st = String(e.outputState ?? "");
        if (st.endsWith("_STARTING") || st.endsWith("_STOPPING")) return;
        const active = !!e.outputActive;
        const paused = st.endsWith("_PAUSED") ? true : st.endsWith("_RESUMED") || st.endsWith("_STARTED") || !active ? false : s.record.paused;
        s.record = { active, paused, ...(active ? { startedAt: s.record.active && s.record.startedAt ? s.record.startedAt : this.now() } : {}) };
        break;
      }
      case "StreamStateChanged": {
        const st = String(e.outputState ?? "");
        if (st.endsWith("_STARTING") || st.endsWith("_STOPPING") || st.endsWith("_RECONNECTING") || st.endsWith("_RECONNECTED")) return;
        const active = !!e.outputActive;
        s.stream = { active, ...(active ? { startedAt: s.stream.active && s.stream.startedAt ? s.stream.startedAt : this.now() } : {}) };
        break;
      }
      case "VirtualcamStateChanged": s.virtualcam = !!e.outputActive; break;
      case "InputMuteStateChanged": if (typeof e.inputName === "string") s.inputs[e.inputName] = { muted: !!e.inputMuted }; break;
      case "InputCreated": case "InputRemoved": case "InputNameChanged": return later(this.loadInputs());
      case "SceneItemEnableStateChanged": {
        const key = this.itemKeys.get(`${e.sceneName}#${e.sceneItemId}`);
        if (key) s.items[key] = !!e.sceneItemEnabled;
        else if (typeof e.sceneName === "string") return later(this.loadItems(e.sceneName));
        break;
      }
      case "SceneItemCreated": case "SceneItemRemoved": case "SceneItemListReindexed":
        if (typeof e.sceneName === "string") later(this.loadItems(e.sceneName));
        return;
      default: return;
    }
    this.changed();
  }

  // ---- actions ----
  private need() { if (!this.ready) throw new Error(NOT_CONNECTED); }

  async scene(name: string) { this.need(); if (!name) throw new Error("Choose a scene"); await this.request("SetCurrentProgramScene", { sceneName: name }); }

  /** record, stream or the virtual camera: toggle, start or stop (start when already on does nothing). */
  async output(kind: "record" | "stream" | "virtualcam", mode = "toggle") {
    this.need();
    const name = kind === "record" ? "Record" : kind === "stream" ? "Stream" : "VirtualCam";
    const active = kind === "record" ? this.st.record.active : kind === "stream" ? this.st.stream.active : this.st.virtualcam;
    if (mode === "start") { if (!active) await this.request(`Start${name}`); return; }
    if (mode === "stop") { if (active) await this.request(`Stop${name}`); return; }
    await this.request(`Toggle${name}`);
  }

  async recordPause(mode = "toggle") {
    this.need();
    if (!this.st.record.active) throw new Error("OBS is not recording");
    const pause = mode === "pause" ? true : mode === "resume" ? false : !this.st.record.paused;
    if (pause !== this.st.record.paused) await this.request(pause ? "PauseRecord" : "ResumeRecord");
  }

  async mute(input: string, mode = "toggle") {
    this.need();
    if (!input) throw new Error("Choose an audio input");
    if (mode === "mute" || mode === "unmute") await this.request("SetInputMute", { inputName: input, inputMuted: mode === "mute" });
    else await this.request("ToggleInputMute", { inputName: input });
  }

  async source(scene: string, source: string, mode = "toggle") {
    this.need();
    if (!scene || !source) throw new Error("Choose a scene and a source");
    const key = `${scene}/${source}`;
    let id = this.itemIds.get(key);
    if (id === undefined) id = (await this.request("GetSceneItemId", { sceneName: scene, sourceName: source })).sceneItemId as number;
    let visible = this.st.items[key];
    if (visible === undefined) visible = !!(await this.request("GetSceneItemEnabled", { sceneName: scene, sceneItemId: id })).sceneItemEnabled;
    const want = mode === "show" ? true : mode === "hide" ? false : !visible;
    await this.request("SetSceneItemEnabled", { sceneName: scene, sceneItemId: id, sceneItemEnabled: want });
  }

  async transition() { this.need(); await this.request("TriggerStudioModeTransition"); }
  async replaySave() { this.need(); await this.request("SaveReplayBuffer"); }
}
