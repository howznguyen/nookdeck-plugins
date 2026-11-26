# OBS Studio

Buttons for OBS Studio that show what OBS is doing: the scene on air, recording and streaming with their time, muted inputs, hidden sources. Works on macOS, Windows and Linux, with OBS 28 or later (its WebSocket server is built in).

## Set up OBS

1. In OBS, open **Tools > WebSocket Server Settings**.
2. Turn on **Enable WebSocket server**. Keep the port at **4455**.
3. Keep **Enable Authentication** on and press **Show Connect Info** to see the password (or set your own).
4. In Nookdeck, open **Plugins > OBS Studio > Settings** and paste the password. Address and port can stay as they are.

The plugin connects to OBS on this computer only: `127.0.0.1` or `localhost`, port 4455. It connects again by itself when OBS is closed and opened later, within about 10 seconds.

## Tiles

| Tile | What it shows | A tap |
|---|---|---|
| Scene | The scene you picked, lit while it is on air | Switches to it |
| Record | REC or Paused with the time, Off when not recording | Start or stop, and Pause / Resume |
| Stream | LIVE with the time, Off when not live | Go live or stop |
| Mute | An audio input, red while muted | Mute or unmute |
| Source visibility | A source of a scene, lit while it is shown | Show or hide |
| Virtual camera | Lit while it is on | Start or stop |
| Transition and replay | | The studio mode transition, or save the replay buffer |

The lists of scenes, inputs and sources in a tile's settings come from OBS, so OBS has to be running when you set up a tile. If it is not, you can type the name.

When OBS is not connected, every OBS tile says **OBS not connected** with the reason (not running, wrong password) and does nothing when tapped. Other buttons are not affected.

## Buttons and macros

Each tap is also an action for a normal button or a macro step: switch scene, record, pause recording, stream, mute an input, show or hide a source, studio mode transition, save the replay buffer, virtual camera. Record, stream and the virtual camera can toggle, start or stop; starting something that already runs does nothing. To go live in one press, make a macro: switch to the Intro scene, wait 3 seconds, start the stream, unmute the mic.

## On Air

While OBS is streaming or recording (paused counts), the plugin turns Nookdeck's On Air on, with the time it started. You can leave OBS out of On Air in Nookdeck's On Air settings.

## Access

- `network`: `ws://127.0.0.1:4455` and `ws://localhost:4455` only, OBS's WebSocket server on this computer.
- `onair`: turns On Air on while you are live or recording.

The password stays on the computer. It is used only to answer OBS's login challenge and is never sent to phones or written to the log.
