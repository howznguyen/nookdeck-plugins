# Pomodoro

A focus timer on one tile. Works on macOS, Windows and Linux.

<img src="preview.png" width="264" alt="A 2x2 Pomodoro tile with demo data: a ring with the time left of a focus block, 3 done today, and a Pause button">

- A ring with the time left in the middle. It fills as the phase runs: your accent colour for focus, green for a break, grey while paused. With it, how many focus blocks you finished today.
- A large **Start** / **Pause** button, with **Reset** (this phase from the top) and **Skip** (to the other phase). A square tile has the ring on top; a tile wider than it is high (2x1, 3x1, 4x1, 3x2, 4x2) has it on the left. A 2x1 tile has room for the ring, the phase, play / pause and **Skip**. Each button is also an action you can put on a normal button.
- When a phase ends, the next one waits for you to press Start. The phones show a notification ("Focus block done", "Break is over"), with a sound if you choose one.

The timer runs on the computer, so it keeps time while the phone sleeps or is closed. It saves the time each phase ends, so it is still right after Nookdeck or the computer restarts. The tile updates every second only while a phase is running.

A focus block counts when its time runs out, on the day it ends. A skipped or reset block does not count.

## Settings

| Setting | Default |
|---|---|
| Focus (minutes) | 25 |
| Break (minutes) | 5 |
| Tell the phones when a phase ends | On |
| Sound when a phase ends | none (or chime, soft, birds) |

1 to 180 minutes. They are the same for every Pomodoro tile: there is one timer. A new length applies from the next phase you start.

## Access

- `storage`: the timer's state and the number of finished blocks per day, for the last 30 days.
- `notify`: the notification when a phase ends. A phase that ended while the computer slept or Nookdeck was off is counted but not announced.

No network, no commands. Needs Nookdeck 0.7 or later.

A phone plays the sound only after it has been tapped once since the page loaded (browsers need that), so a phone you have not touched shows the notification without sound.
