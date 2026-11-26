# Water reminder

Count the glasses of water you drink toward a daily goal, with a reminder on the phone during the hours you choose. Works on macOS, Windows and Linux.

## Tiles

- **Water today**: a ring that fills toward your goal, with the count in the middle, and **+1** and **-1** buttons. A 1x1 tile is one big +1 that shows the count. A 4x2 tile adds the last 7 days. The ring turns green when you reach the goal.
- **Water, last 7 days**: a bar chart of the glasses per day.

Each button is also an action (**One glass more**, **One glass fewer**) for a normal button or a macro.

The count starts again at midnight (the computer's time). The last 30 days are kept.

## Reminders

During the reminder hours, if you have not reached the goal, the phones show "Time for a glass of water" (with the count) when the set number of minutes has passed since your last glass or the last reminder. Drinking a glass starts the wait again. While a reminder is waiting, the tile's ring turns orange and says **Time to drink**, so you see it even if you missed the notification.

The plugin keeps running in the background so reminders come on time while the phones sleep. A phone that was asleep finds the reminder in its notification list. A phone plays the sound only after it has been tapped once since the page loaded (browsers need that).

## Settings

| Setting | Default |
|---|---|
| Glasses a day | 8 (1 to 40) |
| Remind every (minutes, 0: no reminders) | 60 |
| Reminders from (HH:MM) | 09:00 |
| Reminders until (HH:MM) | 21:00 (hours can run past midnight, such as 22:00 to 02:00) |
| Reminder sound | soft (or none, chime, birds) |

## Access

- `storage`: the glasses per day for the last 30 days, and the time of the last glass or reminder.
- `notify`: the reminders.

No network, no commands. Needs Nookdeck 0.7 or later.
