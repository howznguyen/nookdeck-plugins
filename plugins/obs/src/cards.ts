// The tiles, as cards. Pure functions of the OBS state, the tile's settings and size, and the time.
import type { CardData, CardNode } from "@nookdeck/plugin";
import type { ObsError, ObsState } from "./obs";

export interface TileSize { w: number; h: number }
type Tone = "default" | "muted" | "accent" | "ok" | "warn" | "bad";

const root = (n: CardNode): CardData => ({ root: n }) as CardData;
const text = (t: string, o: { size?: "s" | "m" | "l"; tone?: Tone; bold?: boolean } = {}): CardNode => ({ t: "text", text: t.slice(0, 200), ...o }) as CardNode;
const icon = (name: string, tone?: Tone): CardNode => ({ t: "icon", name, ...(tone ? { tone } : {}) }) as CardNode;
const pill = (t: string, tone?: Tone): CardNode => ({ t: "pill", text: t, ...(tone ? { tone } : {}) }) as CardNode;
const col = (children: Array<CardNode | false | null | undefined>, o: Record<string, unknown> = {}): CardNode => ({ t: "col", children: children.filter(Boolean), ...o }) as CardNode;
const row = (children: Array<CardNode | false | null | undefined>, o: Record<string, unknown> = {}): CardNode => ({ t: "row", children: children.filter(Boolean), ...o }) as CardNode;
const button = (label: string, action: string, o: { icon?: string; args?: Record<string, string>; active?: boolean; tone?: Tone } = {}): CardNode =>
  ({ t: "button", label: label.slice(0, 200), action, layout: "tile", ...o }) as CardNode;

/** 1:02:03 or 02:03 */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(r)}` : `${two(m)}:${two(r)}`;
}

export const WHY: Record<ObsError | "starting", string> = {
  starting: "Connecting…",
  unreachable: "OBS is not running, or its WebSocket server is off",
  auth: "Wrong password",
  "no-password": "OBS asks for a password: add it in the plugin settings",
  version: "This OBS is too old: it needs OBS 28 or later",
  "not-allowed": "This plugin may only connect to 127.0.0.1 or localhost on port 4455",
};

/** The neutral state of every OBS tile while OBS is not connected: no buttons, so a tap does nothing. */
export function notConnected(s: ObsState, tile?: TileSize): CardData {
  const small = !tile || tile.w * tile.h <= 1;
  return root(col([
    row([icon("video", "muted"), text(small ? "OBS" : "OBS not connected", { bold: true, tone: "muted" })], { gap: 1 }),
    !small && text(WHY[s.error ?? "starting"], { size: "s", tone: s.error === "auth" || s.error === "no-password" || s.error === "not-allowed" ? "warn" : "muted" }),
    small && text("Not connected", { size: "s", tone: "muted" }),
  ], { gap: 1, align: "center", grow: true }));
}

const chooseFirst = (what: string): CardData => root(col([icon("settings", "muted"), text(`Choose ${what} in this tile's settings`, { size: "s", tone: "muted" })], { gap: 1, align: "center", grow: true }));

export function sceneCard(s: ObsState, scene: string): CardData {
  if (!s.connected) return notConnected(s);
  if (!scene) return chooseFirst("a scene");
  const on = s.scene === scene;
  const missing = !s.scenes.includes(scene);
  return root(button(missing ? `${scene} (not found)` : scene, "scene", { icon: "layout-grid", args: { scene }, active: on }));
}

/** Record or stream: state, elapsed time, start/stop (and pause for a recording). */
export function outputCard(kind: "record" | "stream", s: ObsState, now: number, tile: TileSize = { w: 2, h: 2 }): CardData {
  if (!s.connected) return notConnected(s, tile);
  const o = kind === "record" ? s.record : s.stream;
  const paused = kind === "record" && s.record.paused;
  const time = o.active && o.startedAt ? clock(now - o.startedAt) : "";
  const label = o.active ? (paused ? "Paused" : kind === "record" ? "REC" : "LIVE") : "Off";
  const main = button(o.active ? (time || "Stop") : kind === "record" ? "Record" : "Go live", kind, {
    icon: o.active ? "player-stop" : kind === "record" ? "player-play" : "radio",
    args: { mode: o.active ? "stop" : "start" }, active: o.active, ...(o.active ? { tone: (paused ? "warn" : "bad") as Tone } : {}),
  });
  if (tile.w * tile.h <= 1) return root(main);
  const pause = kind === "record" && o.active && button(paused ? "Resume" : "Pause", "record-pause", { icon: paused ? "player-play" : "player-pause", args: { mode: paused ? "resume" : "pause" }, active: paused });
  return root(col([
    row([pill(label, o.active ? (paused ? "warn" : "bad") : "muted"), { t: "spacer" } as CardNode, tile.h >= 2 && time ? text(time, { bold: true }) : null], { gap: 1 }),
    row([main, pause], { gap: 1, grow: true }),
  ], { gap: 1, grow: true }));
}

export function muteCard(s: ObsState, input: string): CardData {
  if (!s.connected) return notConnected(s);
  if (!input) return chooseFirst("an audio input");
  const st = s.inputs[input];
  if (!st) return root(col([icon("microphone-off", "muted"), text(`${input}: not found in OBS`, { size: "s", tone: "muted" })], { gap: 1, align: "center", grow: true }));
  return root(button(st.muted ? `${input} muted` : input, "mute", { icon: st.muted ? "microphone-off" : "microphone", args: { input, mode: st.muted ? "unmute" : "mute" }, active: st.muted, ...(st.muted ? { tone: "bad" as Tone } : {}) }));
}

export function sourceCard(s: ObsState, scene: string, source: string): CardData {
  if (!s.connected) return notConnected(s);
  if (!scene || !source) return chooseFirst("a scene and a source");
  const v = s.items[`${scene}/${source}`];
  if (v === undefined) return root(col([icon("photo", "muted"), text(`${source} is not in ${scene}`, { size: "s", tone: "muted" })], { gap: 1, align: "center", grow: true }));
  return root(button(v ? source : `${source} hidden`, "source", { icon: "photo", args: { scene, source, mode: v ? "hide" : "show" }, active: v }));
}

export function virtualcamCard(s: ObsState): CardData {
  if (!s.connected) return notConnected(s);
  return root(button(s.virtualcam ? "Virtual camera on" : "Virtual camera", "virtualcam", { icon: "camera", args: { mode: s.virtualcam ? "stop" : "start" }, active: s.virtualcam }));
}

/** Studio mode transition and replay buffer save. */
export function toolsCard(s: ObsState): CardData {
  if (!s.connected) return notConnected(s);
  return root(row([button("Transition", "transition", { icon: "arrows-shuffle" }), button("Save replay", "replay-save", { icon: "device-floppy" })], { gap: 1, grow: true }));
}
