# 202: smoother online races: two STATE channels, voice over the SFU, fewer relay races, later snapshots predicted

Status: current
Checked: 2026-11-10

Branch `web/merge-0713` (after finding 201). The server (`online/server`), the native transport
(`port/render/net`), the browser (`www/sfu.js`, `www/net_worker.js`) and the game core
(`port/hle/puppet.c`).

## Goal and acceptance

A player's 3-player browser race (2026-11-09): the other riders looked far behind while their games
had them ahead; with two players it looked live. Findings 199-201 and the room placement fix
(commit 62a125c) explain most of it: one racer without WebRTC made the race a relay race, its
frames through a room on another continent. Four changes make a race smoother when that happens
and make it happen less.

## Decisions

1. **Two STATE channels** (`SFU_STATE_CHANNELS` "2", set by the site's deploy; one by default, as
   upstream's tests count channels). Cloudflare forwards a subscriber's channels ordered and
   reliable (finding 173), so a lost chunk holds the later messages of its channel until Cloudflare
   resends it (its 1 s timer: the ~1.05 s gaps of finding 200). A sender takes its two STATE
   channels in turn (`sfu.rs` `state_turn`, `sfu.js` `stateTurn`), so a lost chunk holds only every
   second snapshot; the other channel's keep coming. Receivers take `state2` as `state`. The native
   association's channel cap goes from 20 to 40 (three a racer).
2. **A short wait before a race is decided** (auto mode): a racer whose WebRTC session is still
   coming up (it offered, it hasn't failed) gets up to 3 s (`START_SFU_WAIT_MS`) before the room
   picks the race's transport, so a player who just joined doesn't make it a relay race.
3. **Later snapshots predicted further.** A puppet was carried at most 250 ms past its newest
   snapshot (finding 169's `PREDICT_MAX_MS`); a sender whose snapshots usually arrive older (a
   relay race, a far link) was drawn behind by the difference. Now the limit is that sender's usual
   snapshot age plus 50 ms, at most 600 ms (`predict_limit`); corrections still fade in.
4. **Voice over the SFU in an SFU race.** A racer's voice frame (`FRAME_VOICE`) goes to the other
   racers on the STATE channels (loss is fine for voice; a wait behind a lost chunk is not), as
   well as to the room, which now copies an SFU racer's voice only to the members outside the
   race (watching). A relay race's racers still get it from the room.

## Checks

- Server: 202 tests (the relay race's voice, the SFU race's voice not copied to racers).
- Native: `cargo test -p dhd_net`: 24 pass.

## What is left

- The live comparison of one and two STATE channels (`check_sfu.mjs`, 20 s, the gaps over 250 ms
  and the longest gap) on an idle machine.
