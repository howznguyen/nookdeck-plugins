import type { PluginContext, PluginModule, Settings } from "@nookdeck/plugin";
import { WHY, muteCard, notConnected, outputCard, sceneCard, sourceCard, toolsCard, virtualcamCard, type TileSize } from "./cards";
import { Obs, type ObsOptions, type ObsState } from "./obs";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4455;
/** How long a settings form waits for OBS before it says it is not connected. */
export const OPTIONS_WAIT_MS = 3000;

export interface Env {
  now: () => number;
  every: (fn: () => void, ms: number) => () => void;
  /** Test knobs for the connection (back-off, timeouts). */
  obs?: Partial<Pick<ObsOptions, "backoffMs" | "helloMs" | "requestMs">>;
}
const real: Env = {
  now: Date.now,
  every: (fn, ms) => { const t = setInterval(fn, ms); return () => clearInterval(t); },
};

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export function config(s: Settings): { host: string; port: number; password: string } {
  const port = Number(s.port);
  return {
    host: str(s.host) || DEFAULT_HOST,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT,
    password: typeof s.password === "string" ? s.password : "",
  };
}

/** The widgets and what each draws from the OBS state and its tile's settings. */
export function widgetCard(id: string, s: ObsState, settings: Settings, tile: TileSize | undefined, now: number) {
  if (!s.connected) return notConnected(s, tile);
  switch (id) {
    case "scene": return sceneCard(s, str(settings.scene));
    case "record": return outputCard("record", s, now, tile);
    case "stream": return outputCard("stream", s, now, tile);
    case "mute": return muteCard(s, str(settings.input));
    case "source": return sourceCard(s, str(settings.scene), str(settings.source));
    case "virtualcam": return virtualcamCard(s);
    default: return toolsCard(s);
  }
}
export const WIDGETS = ["scene", "record", "stream", "mute", "source", "virtualcam", "tools"] as const;

export function createPlugin(env: Env = real): PluginModule {
  let obs: Obs | null = null;
  let stopTick: (() => void) | null = null;

  return {
    activate(ctx: PluginContext) {
      let state: ObsState | null = null;
      const reported = { stream: false, record: false };

      const pushAll = (ids: readonly string[] = WIDGETS) => {
        const s = state ?? obs!.state();
        for (const id of ids) ctx.widgets.push(id, (tile: TileSize, settings: Settings = {}) => ({ render: "card" as const, data: widgetCard(id, s, settings, tile, env.now()) }));
      };

      /** The elapsed time on the Record and Stream tiles, once a second while one of them runs. */
      const follow = (s: ObsState) => {
        const running = s.record.active || s.stream.active;
        if (!running) { stopTick?.(); stopTick = null; return; }
        if (!stopTick) stopTick = env.every(() => pushAll(["record", "stream"]), 1000);
      };

      /** Live and recording feed On Air (only when the owner allowed it). */
      const onair = (s: ObsState) => {
        for (const kind of ["stream", "record"] as const) {
          const o = s[kind];
          if (o.active === reported[kind]) continue;
          reported[kind] = o.active;
          ctx.onair?.set(kind, o.active, o.active ? o.startedAt : undefined);
        }
      };

      obs = new Obs({
        open: (url, protocols) => ctx.net.websocket(url, { protocols }),
        config: () => config(ctx.settings.get()),
        onChange: (s) => {
          const was = state;
          state = s;
          if (was?.error !== s.error && s.error) ctx.log(`not connected: ${WHY[s.error]}`);
          if (!was?.connected && s.connected) ctx.log("connected to OBS");
          pushAll();
          follow(s);
          onair(s);
        },
        log: (...a) => ctx.log(...a),
        ...env.obs,
      });

      for (const id of WIDGETS) {
        ctx.widgets.provide(id, (settings: Settings, tile?: TileSize) => ({ render: "card", data: widgetCard(id, state ?? obs!.state(), settings, tile, env.now()) }), { every: 60 });
      }

      /** For the settings forms: OBS's own lists. */
      const live = async (): Promise<ObsState> => {
        if (!(await obs!.whenConnected(OPTIONS_WAIT_MS))) throw new Error(WHY[obs!.error() ?? "unreachable"]);
        return obs!.state();
      };
      ctx.settings.options("scenes", async () => (await live()).scenes);
      ctx.settings.options("inputs", async () => Object.keys((await live()).inputs).sort((a, b) => a.localeCompare(b)));
      ctx.settings.options("sources", async (settings: Settings) => {
        const s = await live();
        const scene = str(settings.scene);
        const keys = Object.keys(s.items).filter((k) => !scene || k.startsWith(`${scene}/`));
        return [...new Set(keys.map((k) => k.slice(k.indexOf("/") + 1)))].sort((a, b) => a.localeCompare(b));
      });

      ctx.actions.handle("scene", (s: Settings) => obs!.scene(str(s.scene)));
      ctx.actions.handle("record", (s: Settings) => obs!.output("record", str(s.mode) || "toggle"));
      ctx.actions.handle("record-pause", (s: Settings) => obs!.recordPause(str(s.mode) || "toggle"));
      ctx.actions.handle("stream", (s: Settings) => obs!.output("stream", str(s.mode) || "toggle"));
      ctx.actions.handle("virtualcam", (s: Settings) => obs!.output("virtualcam", str(s.mode) || "toggle"));
      ctx.actions.handle("mute", (s: Settings) => obs!.mute(str(s.input), str(s.mode) || "toggle"));
      ctx.actions.handle("source", (s: Settings) => obs!.source(str(s.scene), str(s.source), str(s.mode) || "toggle"));
      ctx.actions.handle("transition", () => obs!.transition());
      ctx.actions.handle("replay-save", () => obs!.replaySave());

      // new host, port or password: connect again with them
      ctx.settings.onChange?.(() => obs?.restart());
      obs.start();
    },
    deactivate() {
      stopTick?.();
      stopTick = null;
      obs?.stop();
      obs = null;
    },
  };
}

export default createPlugin();
