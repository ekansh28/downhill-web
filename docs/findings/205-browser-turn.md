# 205: browsers use TURN over TLS when UDP to the SFU is blocked

Status: current
Checked: 2026-11-10

Branch `web/browser-turn` from `web/merge-0713`. Server and browser only.

## Goal and acceptance

A browser whose direct WebRTC UDP to the Cloudflare Realtime SFU does not connect gets Cloudflare
TURN over TLS (443) and stays on the SFU transport, instead of making the race a relay race
(finding 199). Players who connect directly are not slowed. With no `TURN_KEY_ID` /
`TURN_KEY_API_TOKEN` on the deployment nothing changes; with them it turns on by itself.

Done when `cd online/server && npx vitest run` and `npm run typecheck` pass, `python tools/check.py
docs` passes, and (once a TURN key exists) `node port/web/check_sfu.mjs ws://127.0.0.1:8787 3 turn`
prints PASS. Out of scope: Android, the native client (it has its own relay, finding 158).

## Progress

- [x] 2026-11-10: `sfu_turn` in `port/web/www/sfu.js`, `"turn":true` on `sfu_offer`
  (`online/server/src/room.ts`), tests, the `turn` mode of `check_sfu.mjs`.
- [x] 2026-11-10: live check with a real TURN key through `wrangler dev` and headless Edge (see Result).

## Decisions

- **Same message and rules as the native client**: `{"type":"sfu_turn"}`, credentials to the asking
  member only, one mint per session, none when the key is absent (the room sends nothing).
- **Ask after 2 s, not from the start**: direct players never touch TURN; a blocked one waits the
  same 2 s the native client does. A relay-only start would also fail on networks where TURN is
  the one thing blocked, and `relay` policy hides a direct path that works.
- **A new connection and a new offer**: the SFU's answer is already applied, and the room's
  signalling has no renegotiation, so the relay cannot be added to the old connection (the native
  client gives its ICE agent a relayed candidate; a browser cannot).
- **`"turn":true` keeps the credentials**: a new offer used to revoke them (the session they were
  minted for ends). With the flag, and over a minute of validity left, the room keeps them and
  marks them as this new session's, so the one-mint rule still holds and the room cannot be asked
  twice. Credentials stay with their member; no other member gets them or learns of them.
- **A failed relay session** goes the normal way (`failed()`, a later plain direct offer and one
  more ask); the room's relay-race fallback (finding 199) remains the last resort.
- **Only `turns:turn.cloudflare.com` URLs** are used, as in the native client.

## Surprises

Live, the forced-TURN session connected within a few seconds of the 2 s wait; that is close to the room's 3 s wait
for connecting racers (`START_SFU_WAIT_MS`); a TURN player in a race that starts sooner is still
a relay race.

## Result

Server tests: a member asks, gets its credentials once; an offer with `turn:true` keeps them for
the new session (no revoke, `turnAttempt` moved, a second ask refused, the other racer sees
nothing and holds none); a plain offer revokes them; without keys nothing is sent and the
session is unchanged.

Live (`check_sfu.mjs ... 3 turn`, relay policy, local `wrangler dev`, shared busy machine): both
games asked, got credentials, re-offered with `turn:true`, connected, were released, and the race
ran on the SFU. Three runs: PASS (180/180 states, 5 events, state delay p50 50-55 ms, p95 117-235
ms); one with a 3.3 s release and 106/180 states; one FAIL with 117-161/180 states and 4/5 events,
p95 up to 1.5 s. The direct run on the same machine was noisy too (p50 340-390 ms). So TURN works
live but loss and delay vary on this machine; not isolated from machine load. Not run: a real
browser behind a UDP-blocking network.
