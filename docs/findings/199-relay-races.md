# 199: relay races: one race, one transport, the room WebSocket when Realtime can't carry it

Status: current
Checked: 2026-11-09

Branch `web/merge-0713` (after the 0.7.13 merge, 4f6ced3, and the renumbering, 1e07c7a). Server,
native transport, protocol; the browser's side is finding 190's client unchanged.

## Goal and acceptance

Upstream 0.7.13 carries race frames only over Cloudflare Realtime SFU (findings 158, 177): a
server without Realtime credentials can't race, a racer whose WebRTC never connects is out of the
race, and this line's browser client, which has no WebRTC yet, can't race at all. This line's
site is its own server and its players are mostly browsers. Wanted: every race still runs, over
the SFU when it can, over the room WebSocket when it can't, with upstream's behaviour untouched
where it is asked for.

Accepted when the server tests pass with upstream's 188 unchanged (pinned to the SFU) and the
relay tests below, and the native game builds with the transport change.

## Decisions

- **One race, one transport.** A Durable Object can't read or write the SFU's DataChannels, so it
  can't bridge a WebRTC racer and a WebSocket racer. The room decides at the race's start and says
  so in the start message: `"transport": "sfu"` or `"relay"`. In a relay race every racer sends
  STATE and EVENT on its room WebSocket and the room copies them to the race's other racers (byte
  1 stamped with the sender's slot, as protocol 3 did); nothing is set up on the SFU and the
  release (`sfu_ready`) doesn't apply.
- **`RACE_TRANSPORT`** (a Worker variable): `auto`, the default, relays a race when this server has
  no Realtime app id and token, when a racer's hello listed `no_sfu` (a game without WebRTC), or
  when a racer's session isn't connected at the start (`sfu_connected` never came: UDP and TURN
  blocked, or still setting up); else the SFU. `sfu` is upstream's rule exactly (a racer whose
  WebRTC fails is out); the server tests pin it, so upstream's tests check upstream's logic.
  `relay` always relays.
- **The welcome says `"sfu": "off"`** when this server has no Realtime here (or the game listed
  `no_sfu`); the room then ignores `sfu_*` messages from that member. The native transport
  (`port/render/net/src/lib.rs`) makes no association on `off`, and in a race whose start says
  `relay` it sends race frames on the WebSocket and keeps any association for the next race.
- **The guard's binary cap** (finding 161: 100 a 5 s window, which only pings use in an SFU race)
  is 2,000 a window for a running relay race's racers: a player's own rider 60 bundles a second,
  each AI bundle 30, voice frames 50 a talker, events and pings.

## Result

- `online/server/src/room.ts`: `transport`, `sfuOn`, `relayRace`, `Race.relay`, the start
  message's `transport`, STATE/EVENT relayed in a relay race, the relay racers' cap.
  `test/relay.test.ts`: 6 tests (no credentials: `off` and relayed in order, stamped, nothing back
  to the sender; 400 frames at once without `too_fast`; `no_sfu` and an unconnected session make
  a relay race; all connected goes over the SFU and drops WebSocket race frames; `relay` forces
  it). All 194 server tests pass.
- `port/render/net/src/lib.rs`: `relay_room`, `relay_race`. The native game builds (`dhd64.exe`).
- `port/web/host`: the site forwards the server's daily job and gets its rate limits.

## What is left

- The browser's own WebRTC client: done in finding 200; a browser without WebRTC (or with
  `?env.DHD_NET_SFU=0`) still says `no_sfu` and gets a relay race.
- A racer whose WebRTC drops mid-race in an SFU race is still out of it (upstream's rule); a relay
  race survives that, an SFU race doesn't switch.
