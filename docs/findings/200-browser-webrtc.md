# 200: the browser races over Cloudflare Realtime SFU (WebRTC on the page's thread)

Status: current
Checked: 2026-11-09

Branch `web/merge-0713` (after finding 199). Browser only; the server and the native game are
unchanged by it.

## Goal and acceptance

Finding 199 relays a race whenever a racer has no WebRTC, and this line's browser client had none:
every race with a browser player went over the room WebSocket (TCP, through the room's city).
Wanted: the browser on the SFU like the native game (docs/online-protocol.md, "Race" and "SFU
signaling"), relay races only where WebRTC can't be had. Accepted when two browser players race
through the real SFU with every frame delivered and its slot right, and the relay checks still
pass.

## Decisions

- **The page's thread.** `RTCPeerConnection` exists only on a page, not in workers. `www/sfu.js`
  runs there; the net worker (`net_worker.js`, finding 196) keeps the room WebSocket and talks to
  it over a `MessagePort` the page hands the game worker, which hands it to the net worker. The net
  worker copies sfu.js the room's welcome, start, ended, error and `sfu_*` messages; sfu.js sends
  its signalling through it; in an SFU race (sfu.js says `route`) the game's STATE and EVENT frames
  go to sfu.js, and frames from the SFU come back into the net worker's own path (voice to its
  decoder, the rest to the game), so client.c and the game see what the socket would have
  brought. The page's thread is nearly idle (the game, the VU and the GS run in workers).
- **What sfu.rs does, in the browser's terms**: one session a room stay (an offer after a welcome
  without `"sfu":"ready"`; the offer carries every candidate, no trickle; a probe channel on id
  1023 puts SCTP in it), negotiated channels for the room's allocations (`state` unordered with no
  retransmits, `events` ordered and reliable), the 8-byte startAt prefix added and checked, the
  sender's slot from `start.players`, early events kept (128) until their start, frames held until
  the room's `sfu_ready` (the newest STATE per bundle, every EVENT), `sfu_ready` once this game's
  channels and every racer's are open or 8 s after the start, a full `sfu_channels` list kept by
  allocation, `sfu_closed`, `sfu_reset` and failures giving a new session after 1 s doubling to a
  minute, a channel not open in 10 s failing the session. A STATE send is skipped while 64 KiB
  wait in its channel (it is superseded).
- **No TURN in the browser.** sfu_turn's credentials belong to a session that already exists,
  and a browser can't add a relayed candidate to it without an ICE restart, which the SFU's answer
  doesn't allow. A browser whose UDP is blocked isn't connected at the race's start, so the race is
  a relay race (finding 199): it still races.
- **The hello**: client.c lists `no_sfu` in the browser build unless the page set `DHD_NET_SFU=1`
  (main.js does when `RTCPeerConnection` exists; `?env.DHD_NET_SFU=0` keeps a browser on relay).

## Result

`port/web/check_sfu.mjs` (headless Edge, two players on one page, `wrangler dev` with the site's
Realtime app in `.dev.vars`, real SFU), from this machine (230 ms to its Cloudflare location):

| run | release after start | STATE delivered | EVENTs | delay p50 / p95 / p99 / max | gaps > 250 ms |
|---|---|---|---|---|---|
| 3 s | 610 ms | 180/180 each way | 5/5 | | host 0, guest 1 (1,035 ms) |
| 20 s | 378 ms | 1200/1200 each way | 5/5 | 65-70 / 196-198 / 279-329 / 436 ms | host 0, guest 1 (285 ms) |

Slots right both ways; every frame came over the SFU. The relay path still passes
(`check_net.mjs`, whose Node clients have no WebRTC, now against a server with Realtime: a relay
race), and the client's C tests.

## What is left

- Finding 173's stall can't be fixed in a browser: Cloudflare forwards a subscriber's channels
  ordered and reliable, so a lost chunk holds the later snapshots until Cloudflare resends it (the
  3 s run's 1,035 ms gap is its 1 s timer). Several STATE channels per sender, taken in turn, would
  hold back only one channel's share; it needs the room to allocate them and the native game to
  send on them too.
- A full browser game in a real two-player online race (not only the transport check).
