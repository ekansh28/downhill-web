# 196: The browser's sockets and voice chat in a worker of their own

Status: current
Checked: 2026-11-09

In the browser the online client (finding 190) and voice chat (finding 183) ran in the game
worker, which lets the browser in only at vsync. So everything the network did waited for the next
field:

- a received message, and the client's 10 ms tick;
- the timestamps of pongs, so the measured round trip (and the server clock offset taken from
  it) carried up to a field of the game's own lateness;
- the voices, which were decoded and mixed into the game's sound in game time (`host_sound_write`
  called `voiceMix`), so a slow or stalled field stalled the voices with it.

A long stall (a slow PC, a shader compile, a disc read) could also trip the silent timeouts:
`client.c`'s `SILENT_MS` on our side, and the server's `RACE_SILENT_MS`.

## The net worker

`www/net_worker.js` holds the WebSockets and voice chat. The game worker starts it (`net.js`), and
both talk through SharedArrayBuffers (`www/net_ring.js`), never through messages:

- **Commands, game to net.** ws.h's open, send and close go into a ring, in the order the client
  made them. The net worker waits on the ring's write word (`Atomics.waitAsync`) and acts at once.
- **Events, net to game.** What the sockets did comes back through a second ring (2 MiB; any
  overflow waits in order in the worker). Each record carries the game worker's clock at the
  moment it happened: performance.now is per worker, so it is converted through `timeOrigin`.
- **Handing events to the client.** `net.js` gives the client the records before every
  `host_service_net_*` call and every 10 ms tick, never inside a call into the client. While it
  hands one over, `web_now_ns` returns that record's time, so the client measures as natively:
  - a pong read a field late still gives the real round trip and server clock;
  - after a stall the client knows when it last heard the server, so the stall is not taken for
    a silent server.
- **The lobby client stays put.** `dhd_net.wasm` stays in the game worker, so the game's
  `host_service_net_*` are still synchronous calls, and every service in `host_api.h` is there
  (including f2d63d6's finish, back, rules, rotation, end_race).

The net worker answers some things itself, whatever the game worker is doing:

- **The server's lobby ping.** `{"type":"ping","s"}` gets the client's own pong at once. The game
  only gets an ALIVE record: no type the client knows, which just counts as heard from the server.
- **A keepalive in a race.** When the game has sent nothing for 1 s (the host's voice frames
  count), the worker sends a ping frame as `client_tick` does: `[PING, slot, the game's clock]`.
  The server hears the racer, and the pong reaches the client as a true round trip on its own
  clock. Natively the same happens because dhd_net's tick runs on its own thread.

The wire is unchanged: the same messages and frames as the native client. The official server,
online/server and native players are all unaffected.

## Voice chat

`port/host/voice.c` and libopus are now their own module, `build/web/dhd_voice.wasm`
(`build_net.py`; `voice_web.c` answers voice.c's host and net.h calls). It runs in the net worker:

- **Hearing.** Voice frames go straight from the socket to voice.c while the game races, as
  `net_voice_hook` does natively; they never reach the game worker. Frames the game hands over
  (`host_service_voice_frame`) and drops travel through the command ring, in order.
- **The mix.** Every 10 ms the worker mixes the voices into a voice ring, up to 50 ms ahead of
  what has been played. Each slot gets the gain and pan the game last gave it: the game's
  `host_service_voice_place` and `mute` write shared words.
- **Playback.** `audio.js`'s new `dhd-voice` worklet plays that ring in real time, beside the
  game's `dhd-ring`. After a run dry it waits for 20 ms before playing again. voice.c's packet
  queue (two to eight packets, by sequence) stays the jitter buffer.
- **The microphone.** The ring from `dhd-mic` is read and encoded here, and sent on the race's
  socket as `client_send_frame`'s frame.
- **State for the game.** Push-to-talk reads the page's keys; a text field holding them is a
  shared word (`net.textInput`). The game's `host_service_voice_state` reads shared words that the
  worker refreshes every 10 ms. Voice settings (`DHD_VOICE*`) are posted to the worker when they
  change.

`dhd_net.wasm` lost libopus: 239 KB instead of 600 KB. The new module is served by `serve.mjs`
and deployed by `host/deploy.mjs`. Without it, the game plays with no voice.

Test hook: `?env.DHD_WEB_STALL=ms[,seconds]` makes the game worker busy-loop `ms` every `seconds`
(5 if not given) at vsync, like a slow field. The status message carries the net worker's
counters (`net`: pongs answered, keepalives, frames mixed, microphone frames) and `stalls`.

## Checks

- `node port/web/check_net.mjs` through `port/tools/local_server.py`: PASS. The game side runs on
  Node's main thread, the net workers on worker_threads, and a third thread plays the page's
  worklets in real time (the host's tone microphone, the guest's voice ring). On top of the
  earlier checks (room, chat, race, STATE frames, voice heard, list, leave):
  - **Room.** The game stalls 2.6 s; the net worker answered 2 server pings meanwhile.
  - **Race, 500 ms stall.** The guest's voice played on: 49-50 chunks of 10 ms, none quiet, none
    short.
  - **Race, 1.5 s stall** (microphone quiet). One keepalive was sent, and the round trip after
    the stall was 1-4 ms (local server).
- The browser build in headless Edge (`check_browser.mjs`, `?env.DHD_WEB_STALL=500,3`): the game
  ran to field 736 through 8 stalls of 500 ms. The net worker started and dhd_voice.wasm loaded,
  and the voice ring was filled to its 50 ms. Headless Edge never drained that ring: it has no
  audio output, so no sound is heard there.
- `port/tools/test_voice.py`: PASS. `port/net/build_tests.py`: join, session, keep_ready ok.
  `online/server` `npm test`: 95 of 95. voice.c, port/net's C and the server are unchanged.

## Not done

- Not yet seen in a real two-player browser race with the full game, nor browser against native.
  The wire is the same, so nothing is expected to differ.
- The lobby client itself still runs in the game worker. Its state machine reacts at the game's
  next call or tick, as before, but with the true times. Moving it as well would need either a
  shared-memory `dhd_net.wasm` with real locks, or a synchronous cross-worker call for each
  service (dozens a field). Neither was needed for the goals here.
