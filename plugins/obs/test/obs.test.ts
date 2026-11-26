import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { clock, notConnected, outputCard, sceneCard, WHY } from "../src/cards";
import { config, createPlugin, widgetCard } from "../src/index";
import { NOT_CONNECTED, OBS_EVENTS, obsAuth, type ObsState, type Socket } from "../src/obs";

setDefaultTimeout(20_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 6000, what = "") {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (f()) return; await sleep(10); }
  throw new Error(`timed out waiting ${what || f.toString().slice(0, 100)}`);
}

/** The reference algorithm written out apart from the plugin (obs-websocket v5 docs). */
const refAuth = (pw: string, salt: string, challenge: string) => {
  const b64 = (s: string) => createHash("sha256").update(s).digest("base64");
  return b64(b64(pw + salt) + challenge);
};

/**
 * A fake OBS 30 with obs-websocket v5: Hello (with an auth challenge when it has a password), Identify checked (close 4009 on a wrong
 * password), the requests the plugin uses, and events when its state changes (from a request, or "in OBS" through the helpers).
 */
function fakeObs(opts: { password?: string; port?: number; silent?: boolean; record?: { active: boolean; duration: number } } = {}) {
  const salt = "c2FsdHNhbHQ=", challenge = "Y2hhbGxlbmdl";
  const st = {
    scenes: ["Intro", "Main", "BRB"],
    current: "Main",
    record: { active: opts.record?.active ?? false, paused: false, duration: opts.record?.duration ?? 0 },
    stream: { active: false, duration: 0 },
    vcam: false,
    inputs: { Mic: false, "Desktop Audio": true } as Record<string, boolean>,
    videoInputs: ["Camera"],
    items: { Main: [{ id: 1, source: "Camera", on: true }, { id: 2, source: "Logo", on: false }], Intro: [{ id: 5, source: "Title", on: true }], BRB: [] } as Record<string, Array<{ id: number; source: string; on: boolean }>>,
  };
  const requests: Array<{ type: string; data: any }> = [];
  const identifies: any[] = [];
  let connections = 0;
  const socks = new Set<any>();
  const event = (eventType: string, eventData: any) => { for (const ws of socks) if (ws.data.identified) ws.send(JSON.stringify({ op: 5, d: { eventType, eventIntent: 0, eventData } })); };
  const out = (o: "record" | "stream", active: boolean, state: string) => event(o === "record" ? "RecordStateChanged" : "StreamStateChanged", { outputActive: active, outputState: `OBS_WEBSOCKET_OUTPUT_${state}` });
  function handle(type: string, d: any): { ok: boolean; data?: any; comment?: string } {
    switch (type) {
      case "GetSceneList": return { ok: true, data: { currentProgramSceneName: st.current, scenes: st.scenes.map((s, i) => ({ sceneName: s, sceneIndex: st.scenes.length - 1 - i })).reverse() } };
      case "SetCurrentProgramScene": if (!st.scenes.includes(d.sceneName)) return { ok: false, comment: "No source was found" }; st.current = d.sceneName; event("CurrentProgramSceneChanged", { sceneName: st.current }); return { ok: true };
      case "GetRecordStatus": return { ok: true, data: { outputActive: st.record.active, outputPaused: st.record.paused, outputDuration: st.record.duration } };
      case "GetStreamStatus": return { ok: true, data: { outputActive: st.stream.active, outputDuration: st.stream.duration } };
      case "GetVirtualCamStatus": return { ok: true, data: { outputActive: st.vcam } };
      case "ToggleRecord": case "StartRecord": case "StopRecord": {
        const on = type === "ToggleRecord" ? !st.record.active : type === "StartRecord";
        if (on === st.record.active) return { ok: false, comment: "output already in that state" };
        out("record", on, on ? "STARTING" : "STOPPING");
        st.record = { active: on, paused: false, duration: 0 }; out("record", on, on ? "STARTED" : "STOPPED"); return { ok: true };
      }
      case "PauseRecord": st.record.paused = true; out("record", true, "PAUSED"); return { ok: true };
      case "ResumeRecord": st.record.paused = false; out("record", true, "RESUMED"); return { ok: true };
      case "ToggleStream": case "StartStream": case "StopStream": {
        const on = type === "ToggleStream" ? !st.stream.active : type === "StartStream";
        if (on === st.stream.active) return { ok: false, comment: "output already in that state" };
        st.stream = { active: on, duration: 0 }; out("stream", on, on ? "STARTED" : "STOPPED"); return { ok: true };
      }
      case "ToggleVirtualCam": case "StartVirtualCam": case "StopVirtualCam": {
        st.vcam = type === "ToggleVirtualCam" ? !st.vcam : type === "StartVirtualCam";
        event("VirtualcamStateChanged", { outputActive: st.vcam, outputState: st.vcam ? "OBS_WEBSOCKET_OUTPUT_STARTED" : "OBS_WEBSOCKET_OUTPUT_STOPPED" }); return { ok: true };
      }
      case "GetInputList": return { ok: true, data: { inputs: [...Object.keys(st.inputs), ...st.videoInputs].map((n) => ({ inputName: n })) } };
      case "GetInputMute": if (!(d.inputName in st.inputs)) return { ok: false, comment: "The specified input does not support audio" }; return { ok: true, data: { inputMuted: st.inputs[d.inputName] } };
      case "ToggleInputMute": case "SetInputMute": {
        if (!(d.inputName in st.inputs)) return { ok: false, comment: "no audio" };
        st.inputs[d.inputName] = type === "ToggleInputMute" ? !st.inputs[d.inputName] : !!d.inputMuted;
        event("InputMuteStateChanged", { inputName: d.inputName, inputMuted: st.inputs[d.inputName] }); return { ok: true };
      }
      case "GetSceneItemList": return { ok: true, data: { sceneItems: (st.items[d.sceneName] ?? []).map((i) => ({ sceneItemId: i.id, sourceName: i.source, sceneItemEnabled: i.on })) } };
      case "GetSceneItemId": { const it = (st.items[d.sceneName] ?? []).find((i) => i.source === d.sourceName); return it ? { ok: true, data: { sceneItemId: it.id } } : { ok: false, comment: "not found" }; }
      case "SetSceneItemEnabled": {
        const it = (st.items[d.sceneName] ?? []).find((i) => i.id === d.sceneItemId);
        if (!it) return { ok: false, comment: "not found" };
        it.on = !!d.sceneItemEnabled; event("SceneItemEnableStateChanged", { sceneName: d.sceneName, sceneItemId: it.id, sceneItemEnabled: it.on }); return { ok: true };
      }
      case "TriggerStudioModeTransition": return { ok: false, comment: "Studio mode is not active" };
      case "SaveReplayBuffer": return { ok: true };
      default: return { ok: false, comment: `unknown request ${type}` };
    }
  }
  const serve = (port: number) => Bun.serve<{ identified: boolean }, undefined>({
    port, hostname: "127.0.0.1",
    fetch(req, server) {
      if (!req.headers.get("sec-websocket-protocol")?.includes("obswebsocket.json")) return new Response("bad subprotocol", { status: 400 });
      return server.upgrade(req, { data: { identified: false }, headers: { "Sec-WebSocket-Protocol": "obswebsocket.json" } }) ? undefined : new Response("ws only", { status: 400 });
    },
    websocket: {
      open(ws) {
        connections++; socks.add(ws);
        if (!opts.silent) ws.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: "5.5.2", rpcVersion: 1, ...(opts.password ? { authentication: { challenge, salt } } : {}) } }));
      },
      close(ws) { socks.delete(ws); },
      message(ws, raw) {
        const m = JSON.parse(String(raw));
        if (m.op === 1) {
          identifies.push(m.d);
          if (opts.password && m.d.authentication !== refAuth(opts.password, salt, challenge)) { ws.close(4009, "Authentication failed."); return; }
          ws.data.identified = true;
          ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
          return;
        }
        if (m.op === 6 && ws.data.identified) {
          requests.push({ type: m.d.requestType, data: m.d.requestData });
          const r = handle(m.d.requestType, m.d.requestData ?? {});
          ws.send(JSON.stringify({ op: 7, d: { requestType: m.d.requestType, requestId: m.d.requestId, requestStatus: { result: r.ok, code: r.ok ? 100 : 600, ...(r.comment ? { comment: r.comment } : {}) }, ...(r.data ? { responseData: r.data } : {}) } }));
        }
      },
    },
  });
  let server = serve(opts.port ?? 0);
  const port = server.port as number;
  return {
    st, requests, identifies, port,
    get connections() { return connections; },
    obsSwitchScene(s: string) { st.current = s; event("CurrentProgramSceneChanged", { sceneName: s }); },
    obsStopRecord() { st.record = { active: false, paused: false, duration: 0 }; out("record", false, "STOPPED"); },
    obsMute(input: string, muted: boolean) { st.inputs[input] = muted; event("InputMuteStateChanged", { inputName: input, inputMuted: muted }); },
    /** OBS quits, and later starts again on the same port */
    quit() { for (const ws of socks) ws.close(1001, "OBS quit"); server.stop(true); },
    relaunch() { server = serve(port); },
    stop() { server.stop(true); },
  };
}

class PermissionError extends Error { permission = "network"; }

/** A Socket like the agent's ctx.net.websocket gives: frames before onMessage are kept, a not-listed origin is refused. */
function opener(allowed: (origin: string) => boolean) {
  return (url: string, o?: { protocols?: string[] }): Promise<Socket> => new Promise((resolve, reject) => {
    const origin = new URL(url).host;
    if (!allowed(origin)) return reject(new PermissionError(`permission denied: network (${origin} is not listed)`));
    const w = new WebSocket(url, o?.protocols);
    const early: string[] = [];
    let onMsg: ((t: string) => void) | null = null;
    const onClose: Array<(c: number, r: string) => void> = [];
    let open = false;
    w.onmessage = (e) => { const t = String(e.data); if (onMsg) onMsg(t); else early.push(t); };
    w.onclose = (e) => { if (!open) reject(new Error("cannot connect")); else for (const f of onClose) f(e.code, e.reason); };
    w.onopen = () => {
      open = true;
      resolve({
        send: (t) => w.send(t),
        onMessage: (fn) => { onMsg = fn; while (early.length) fn(early.shift()!); },
        onClose: (fn) => { onClose.push(fn); },
        close: () => w.close(),
      });
    };
  });
}

type Card = { root: any };
/** A fake plugin context: the plugin's pushes per widget (made for one tile with the given settings), On Air calls, handlers. */
function harness(o: { port: number; password?: string; allowed?: (origin: string) => boolean; tileSettings?: Record<string, Record<string, unknown>>; ticks?: boolean; onair?: boolean }) {
  const settings: Record<string, unknown> = { host: "127.0.0.1", port: o.port, ...(o.password !== undefined ? { password: o.password } : {}) };
  const cards: Record<string, Card> = {};
  const pushes: Record<string, number> = {};
  const onair: Array<[string, boolean, number | undefined]> = [];
  const handlers: Record<string, (s: any) => Promise<void>> = {};
  const providers: Record<string, (s: any, t: any) => any> = {};
  const options: Record<string, (s: any) => Promise<string[]>> = {};
  const logs: string[] = [];
  const changes: Array<() => void> = [];
  let tick: (() => void) | null = null;
  const ctx: any = {
    id: "dev.nookdeck.obs",
    log: (...a: unknown[]) => logs.push(a.join(" ")),
    settings: { get: () => ({ ...settings }), onChange: (fn: () => void) => changes.push(fn), options: (id: string, fn: any) => { options[id] = fn; } },
    net: { websocket: opener(o.allowed ?? ((h) => h === `127.0.0.1:${o.port}` || h === `localhost:${o.port}`)) },
    ...(o.onair === false ? {} : { onair: { set: (k: string, on: boolean, since?: number) => onair.push([k, on, since]) } }),
    widgets: {
      provide: (id: string, fn: any) => { providers[id] = fn; },
      push: async (id: string, u: any) => {
        const made = typeof u === "function" ? await u({ w: 2, h: 2 }, o.tileSettings?.[id] ?? {}) : u;
        cards[id] = made.data; pushes[id] = (pushes[id] ?? 0) + 1;
      },
    },
    actions: { handle: (id: string, fn: any) => { handlers[id] = fn; } },
  };
  const plugin = createPlugin({ now: Date.now, every: (fn) => { tick = fn; return () => { tick = null; }; }, obs: { backoffMs: [60, 120], helloMs: 600, requestMs: 2000 } });
  plugin.activate(ctx);
  return {
    ctx, cards, pushes, onair, handlers, providers, options, logs, settings,
    get ticking() { return tick !== null; },
    tick() { tick?.(); },
    change(patch: Record<string, unknown>) { Object.assign(settings, patch); for (const f of changes) f(); },
    stop: () => plugin.deactivate?.(),
  };
}

const texts = (n: any, out: string[] = []): string[] => {
  if (!n || typeof n !== "object") return out;
  if (typeof n.text === "string") out.push(n.text);
  if (typeof n.label === "string") out.push(n.label);
  for (const c of n.children ?? []) texts(c, out);
  return out;
};
const buttons = (n: any, out: any[] = []): any[] => { if (n?.t === "button") out.push(n); for (const c of n?.children ?? []) buttons(c, out); return out; };
const connected = (h: ReturnType<typeof harness>) => () => !!h.cards.tools && buttons(h.cards.tools.root).length > 0;

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) { try { cleanup.pop()!(); } catch { /* gone */ } } });
function setup(...a: Parameters<typeof fakeObs>) { const obs = fakeObs(...a); cleanup.push(() => obs.stop()); return obs; }
function start(o: Parameters<typeof harness>[0]) { const h = harness(o); cleanup.push(() => h.stop()); return h; }

describe("the protocol", () => {
  test("auth string: the obs-websocket docs example, and the same as the reference algorithm", () => {
    expect(obsAuth("supersecretpassword", "lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=", "+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=")).toBe("1Ct943GAT+6YQUUX47Ia/ncufilbe6+oD6lY+5kaCu4=");
    expect(obsAuth("pw", "c2FsdA==", "Y2g=")).toBe(refAuth("pw", "c2FsdA==", "Y2g="));
  });
  test("settings: defaults for host and port, a bad port falls back", () => {
    expect(config({})).toEqual({ host: "127.0.0.1", port: 4455, password: "" });
    expect(config({ host: "localhost", port: 99999, password: "x" })).toEqual({ host: "localhost", port: 4455, password: "x" });
  });
});

describe("connected to OBS", () => {
  test("Identify with the password; scenes in OBS's order, audio inputs only, scene items; tiles show the live state", async () => {
    const obs = setup({ password: "s3cret" });
    const h = start({ port: obs.port, password: "s3cret", tileSettings: { scene: { scene: "Main" }, mute: { input: "Mic" }, source: { scene: "Main", source: "Logo" } } });
    await until(connected(h));
    expect(obs.identifies[0]).toMatchObject({ rpcVersion: 1, eventSubscriptions: OBS_EVENTS });
    expect(await h.options.scenes!({})).toEqual(["Intro", "Main", "BRB"]);
    expect(await h.options.inputs!({})).toEqual(["Desktop Audio", "Mic"]);
    expect(await h.options.sources!({ scene: "Main" })).toEqual(["Camera", "Logo"]);
    expect(await h.options.sources!({})).toEqual(["Camera", "Logo", "Title"]);
    expect(buttons(h.cards.scene!.root)[0]).toMatchObject({ label: "Main", active: true, action: "scene", args: { scene: "Main" } });
    expect(buttons(h.cards.mute!.root)[0]).toMatchObject({ label: "Mic", active: false, args: { input: "Mic", mode: "mute" } });
    expect(buttons(h.cards.source!.root)[0]).toMatchObject({ label: "Logo hidden", active: false, args: { mode: "show" } });
    expect(texts(h.cards.record!.root)).toContain("Off");
    expect(h.onair).toEqual([]); // nothing live, nothing reported
    expect(h.logs.join("\n")).not.toContain("s3cret");
  });

  test("buttons drive OBS, and what changes in OBS itself shows on the tiles", async () => {
    const obs = setup();
    const h = start({ port: obs.port, tileSettings: { scene: { scene: "Intro" }, mute: { input: "Mic" }, source: { scene: "Main", source: "Camera" } } });
    await until(connected(h));
    await h.handlers.scene!({ scene: "Intro" });
    await until(() => buttons(h.cards.scene!.root)[0]?.active === true, 3000, "Intro lit");
    obs.obsSwitchScene("BRB");
    await until(() => buttons(h.cards.scene!.root)[0]?.active === false, 3000, "Intro unlit");

    await h.handlers.mute!({ input: "Mic", mode: "mute" });
    await until(() => buttons(h.cards.mute!.root)[0]?.active === true, 3000, "muted");
    obs.obsMute("Mic", false);
    await until(() => buttons(h.cards.mute!.root)[0]?.active === false, 3000, "unmuted in OBS");
    await h.handlers.mute!({ input: "Mic" }); // toggle
    expect(obs.st.inputs.Mic).toBe(true);

    await h.handlers.source!({ scene: "Main", source: "Camera", mode: "hide" });
    await until(() => buttons(h.cards.source!.root)[0]?.active === false, 3000, "hidden");
    expect(obs.st.items.Main![0]!.on).toBe(false);

    await h.handlers.virtualcam!({ mode: "start" });
    await until(() => buttons(h.cards.virtualcam!.root)[0]?.active === true, 3000, "vcam");
    await h.handlers.virtualcam!({ mode: "start" }); // already on: nothing sent
    expect(obs.requests.filter((r) => r.type === "StartVirtualCam").length).toBe(1);

    await h.handlers["replay-save"]!({});
    expect(obs.requests.at(-1)!.type).toBe("SaveReplayBuffer");
    await expect(h.handlers.transition!({})).rejects.toThrow("Studio mode is not active");
    await expect(h.handlers.scene!({ scene: "Nope" })).rejects.toThrow(/OBS: No source/);
  });

  test("record and stream: elapsed time, pause, and On Air while live or recording", async () => {
    const obs = setup();
    const h = start({ port: obs.port });
    await until(connected(h));
    const t0 = Date.now();
    await h.handlers.record!({ mode: "start" });
    await until(() => h.onair.length === 1, 3000, "onair record");
    expect(h.onair[0]![0]).toBe("record");
    expect(h.onair[0]![1]).toBe(true);
    expect(Math.abs(h.onair[0]![2]! - t0)).toBeLessThan(2000);
    expect(h.ticking).toBe(true);
    await until(() => texts(h.cards.record!.root).includes("REC"));
    expect(buttons(h.cards.record!.root).map((b) => b.action)).toEqual(["record", "record-pause"]);

    await h.handlers["record-pause"]!({ mode: "pause" });
    await until(() => texts(h.cards.record!.root).includes("Paused"), 3000, "paused");
    expect(h.onair.length).toBe(1); // a paused recording still counts
    await h.handlers["record-pause"]!({}); // toggle: resume
    expect(obs.requests.at(-1)!.type).toBe("ResumeRecord");

    await h.handlers.stream!({ mode: "start" });
    await until(() => h.onair.some(([k, on]) => k === "stream" && on), 3000, "onair stream");
    obs.obsStopRecord(); // stopped in OBS itself
    await until(() => h.onair.some(([k, on]) => k === "record" && !on), 3000, "record off");
    await h.handlers.stream!({ mode: "stop" });
    await until(() => h.onair.some(([k, on]) => k === "stream" && !on), 3000, "stream off");
    await until(() => !h.ticking, 3000, "tick stops");
    await h.handlers.stream!({ mode: "stop" }); // already stopped: nothing sent
    expect(obs.requests.filter((r) => r.type === "StopStream").length).toBe(1);
    await expect(h.handlers["record-pause"]!({})).rejects.toThrow("OBS is not recording");
  });

  test("a recording that runs when the plugin connects: its start time comes from OBS's duration", async () => {
    const obs = setup({ record: { active: true, duration: 65_000 } });
    const h = start({ port: obs.port });
    await until(() => h.onair.length === 1);
    expect(h.onair[0]![1]).toBe(true);
    expect(Math.abs(h.onair[0]![2]! - (Date.now() - 65_000))).toBeLessThan(2000);
    h.tick();
    await until(() => texts(h.cards.record!.root).some((t) => /^01:0[5-9]$/.test(t)), 3000, "elapsed 01:05");
  });

  test("without the onair permission the plugin still works (ctx.onair is absent)", async () => {
    const obs = setup({ record: { active: true, duration: 0 } });
    const h = start({ port: obs.port, onair: false });
    await until(connected(h));
    expect(texts(h.cards.record!.root)).toContain("REC");
  });
});

describe("OBS not connected", () => {
  test("OBS closed: tiles show OBS not connected with no buttons, actions send nothing; OBS starts: back within the back-off", async () => {
    const obs = setup({ record: { active: true, duration: 0 } });
    const h = start({ port: obs.port });
    await until(connected(h));
    obs.quit();
    await until(() => texts(h.cards.scene!.root).includes("OBS not connected"), 3000, "not connected");
    for (const id of ["scene", "record", "stream", "mute", "source", "virtualcam", "tools"]) expect(buttons(h.cards[id]!.root)).toEqual([]);
    expect(texts(h.cards.record!.root)).toContain(WHY.unreachable);
    expect(h.onair.at(-1)).toEqual(["record", false, undefined]); // On Air goes off with OBS
    const before = obs.requests.length;
    await expect(h.handlers.scene!({ scene: "Main" })).rejects.toThrow(NOT_CONNECTED);
    await expect(h.options.scenes!({})).rejects.toThrow(WHY.unreachable);
    expect(obs.requests.length).toBe(before);
    obs.relaunch();
    await until(connected(h), 5000, "reconnected");
    expect(obs.connections).toBeGreaterThanOrEqual(2);
  });

  test("a wrong password: 'Wrong password', and no retry until the settings change", async () => {
    const obs = setup({ password: "right" });
    const h = start({ port: obs.port, password: "wrong" });
    await until(() => texts(h.cards.tools?.root).includes(WHY.auth), 3000, "auth");
    await sleep(400);
    expect(obs.connections).toBe(1);
    h.change({ password: "right" });
    await until(connected(h), 3000, "connected after the fix");
  });

  test("OBS asks for a password and none is set", async () => {
    const obs = setup({ password: "right" });
    const h = start({ port: obs.port });
    await until(() => texts(h.cards.tools?.root).includes(WHY["no-password"]), 3000);
    expect(obs.identifies).toEqual([]);
  });

  test("something answers but never says Hello (OBS still starting): unreachable, and tried again", async () => {
    const obs = setup({ silent: true });
    const h = start({ port: obs.port });
    await until(() => texts(h.cards.tools?.root).includes(WHY.unreachable), 3000);
    await until(() => obs.connections >= 2, 3000, "retried");
  });

  test("an address the plugin's permissions do not list: not allowed, no retry", async () => {
    const obs = setup();
    const h = start({ port: obs.port, allowed: () => false });
    await until(() => texts(h.cards.tools?.root).includes(WHY["not-allowed"]), 3000);
    await sleep(300);
    expect(obs.connections).toBe(0);
  });

  test("nothing listens at all: unreachable, retried with back-off", async () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = probe.port as number;
    probe.stop(true);
    const h = start({ port });
    await until(() => texts(h.cards.tools?.root).includes(WHY.unreachable), 3000);
    // the port was just freed: binding it again can fail for a moment
    let obs: ReturnType<typeof fakeObs> | null = null;
    for (let i = 0; !obs; i++) { try { obs = setup({ port }); } catch (e) { if (i > 40) throw e; await sleep(50); } }
    await until(connected(h), 5000, "found once it listens");
    expect(obs.connections).toBe(1);
  });
});

describe("cards", () => {
  const off: ObsState = { connected: false, scenes: [], record: { active: false, paused: false }, stream: { active: false }, virtualcam: false, inputs: {}, items: {} };
  const on: ObsState = { ...off, connected: true, scene: "Main", scenes: ["Main"], record: { active: true, paused: false, startedAt: 1_000 } };
  test("clock", () => {
    expect(clock(0)).toBe("00:00");
    expect(clock(65_000)).toBe("01:05");
    expect(clock(3_725_000)).toBe("1:02:05");
  });
  test("not connected has no button on any size; a 1x1 record tile is one button with the time", () => {
    expect(buttons(notConnected(off, { w: 1, h: 1 }).root)).toEqual([]);
    expect(texts(notConnected({ ...off, error: "auth" }, { w: 2, h: 2 }).root)).toContain("Wrong password");
    const small = outputCard("record", on, 66_000, { w: 1, h: 1 }).root as any;
    expect(small).toMatchObject({ t: "button", label: "01:05", args: { mode: "stop" }, tone: "bad" });
  });
  test("a scene that is gone from OBS says so; no scene chosen yet asks for one", () => {
    expect(texts(sceneCard(on, "Old").root)).toEqual(["Old (not found)"]);
    expect(texts(widgetCard("scene", on, {}, { w: 1, h: 1 }, 0).root).join(" ")).toContain("Choose a scene");
  });
});
