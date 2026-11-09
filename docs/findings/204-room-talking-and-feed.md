# 204: who is talking in the room, and more race feed lines

Status: current
Checked: 2026-11-10

Branch `web/room-feed` from `web/self-host` fec667e. Follows the voice-anywhere and race-feed
commit (2033233). Client only: no server or protocol change.

## Goal and acceptance

- The room's player list shows who is talking.
- The race feed also says who finishes and in what place, and who rejoins after a drop.
- The room chat notes who joins or leaves the room.

Done when the unit tests below pass, the browser core builds (`strict link: ok`, `== web: done`)
and the headless race shows offline play unchanged (4300 fields, exit 0, `vu_steps` 82315732).

## Progress

- [x] 2026-11-10: TALKING in the player list, the finish and rejoin feed lines, the room chat's
  JOINED / LEFT THE ROOM notes, their tests.

## Decisions

- **TALKING** (`port/hle/online_menu.c` `talk_update`, `member_talking`, `draw_card`). A member's
  card lights in teal and TALKING takes the state tag's place (READY, WAIT...) while
  `host_service_voice_state(VOICE_STATE_TALKING, slot)` says the slot was heard in the last 300 ms.
  The left stripe keeps READY's colour, so nothing is lost. The name and its HOST / YOU tags keep
  their size: the row's width doesn't change. This player's own card says TALKING while its
  microphone sends (`VOICE_STATE_TRANSMITTING`), since its own voice never comes back.
- **The voice slot** is the one room.ts `relayVoice` stamps: with no race (the snapshot's
  `started`, a session room's `phase` "racing"), the member's index in the member list; in a
  race, its race slot, then the members not racing after the racers in list order
  (`feed_voice_slot`, `port/hle/online_feed.h`). The race's slots are not in the room snapshot.
  A PC that raced in the race has them from its start message (`NetLobby.racer`). A PC that
  watched the race begin from the room works them out as room.ts `startRace` orders them: the
  members in the race, host first, then in list order. A page opened while a race was already
  running shows no one as talking until the race ends: a racer who left before then would shift
  every slot after it, and the wrong player would light up.
- **NAME FINISHED 2ND** (`port/hle/online.c` `read_finish`): said once per player, this player
  included ("YOU FINISHED 1ST"), when the finish is recorded (this PC's own, an `EVENT_FINISH`,
  or the host's results for one not heard before). The place is the rider's among the finish
  times known here, computer riders included, quicker first and a tie to the lower rider
  (`feed_place`): the order the host's results take (`finish_step`). A finish heard late (an
  event slower than a later finisher's) can name a place one too high. Computer riders' finishes
  aren't said.
- **NAME REJOINED** (`feed_rejoins`): a racer whose room connection drops races on over the SFU
  (finding 175), so its snapshots needn't stop and can't tell. What the room snapshot shows is its
  round trip: room.ts forgets a member's rtts when its connection drops (it is away) and measures
  them again from the first pings after the rejoin. So a racer whose `rttMs` was known, then
  absent, then known again in the same race has rejoined. Checked every 0.25 s with check_left.
  The line comes with the first room snapshot after the rejoin's first pongs, a few seconds
  after the rejoin. Session rooms only: elsewhere a drop is a leave, and check_left says
  DISCONNECTED.
- **JOINED / LEFT THE ROOM** (`port/net/client.c` `note_members`): each room message's member
  list is compared with the last one; a new id is "NAME JOINED THE ROOM", a missing one "NAME
  LEFT THE ROOM". Not for the first room message of a room (the room as found), nor this player.
  A member away after a drop stays listed (finding 137), so a drop and rejoin says nothing. The
  lines go into the chat ring as `NET_CHAT_ROOM` (-2, net.h), a new member_id beside the
  existing note's `NET_CHAT_NOTE` (-1). The room chat shows them in lilac. The race chat skips
  them (`race_chat_step`). The room page's toasts skip them too, because room_news already
  toasts "NAME JOINED" / "NAME LEFT".
- The place words ("1ST", "11TH", "22ND") moved into `feed_ordinal`, used by the room page too.

## Surprises

- test_loopback's chat check counted the ring's lines from 1. With the JOINED notes, each player's
  ring now starts with one note for every player its first room message didn't list. The players'
  hellos reach the test server in no fixed order, so the count varies; the test now takes that
  count as the base.

## Result

- `port/hle/online_feed.h` (new): `feed_ordinal`, `feed_place`, `feed_voice_slot`;
  `port/hle/test_online_feed.c` checks them (`test_runtime.py`, guest test `online-feed`).
- `port/net/test_room_notes.c` (new; `build_tests.py test_room_notes`): no notes for the room as
  found or an unchanged list, one per join and per leave, none after a new room's first message.
- Checked: `python port/tools/build.py --web` (strict link: ok, == web: done), the headless race
  (4300 fields, exit 0, vu_steps 82315732, as before), `python port/tools/test_runtime.py`,
  `python port/net/build_tests.py test_loopback test_session test_keep_ready test_room_notes`.
- Not seen on screen: a live room with talking members, a rejoin mid-race, the feed lines in a
  race of several players. The rejoin line's delay hangs on the room's ping interval.
