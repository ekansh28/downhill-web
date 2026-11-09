/* The online room's and race's small words (finding 204): a place as text, a rider's place from
   the finish times known, and the voice slot the server stamps on a member's voice frames. Pure:
   no game, host or network state, so port/hle/test_online_feed.c checks the code the game runs. */
#ifndef DHD_ONLINE_FEED_H
#define DHD_ONLINE_FEED_H
#include <stdio.h>

/* 1 -> "1ST", 2 -> "2ND", 3 -> "3RD", 4 -> "4TH", 11-13 -> "11TH".. "13TH", 21 -> "21ST". */
static inline void feed_ordinal(char *out, int size, int place)
{
    const char *suffix = place % 100 / 10 == 1 ? "TH" : place % 10 == 1 ? "ST" : place % 10 == 2 ? "ND"
                         : place % 10 == 3 ? "RD" : "TH";
    snprintf(out, size, "%d%s", place, suffix);
}

/* The place of rider `who` among n riders' finish times (race ticks, -1 not finished): one more
   than the riders with a quicker time (a tie: the lower rider first). 0 when `who` hasn't
   finished. The host's results go by the same order (online.c finish_step). */
static inline int feed_place(const int *finish, int n, int who)
{
    if (who < 0 || who >= n || finish[who] < 0) return 0;
    int place = 1;
    for (int j = 0; j < n; j++)
        if (j != who && finish[j] >= 0 && (finish[j] < finish[who] || (finish[j] == finish[who] && j < who))) place++;
    return place;
}

/* The slot the server stamps on member id's voice frames (online/server/src/room.ts relayVoice):
   with no race (nracers < 0), the member's index in the room's member list; in a race, its race
   slot (racers: member ids by slot), and a member not racing comes after the racers, in member
   list order. -1 when id is in neither list. */
static inline int feed_voice_slot(int id, const int *members, int nmembers, const int *racers, int nracers)
{
    if (nracers < 0) {
        for (int i = 0; i < nmembers; i++)
            if (members[i] == id) return i;
        return -1;
    }
    for (int s = 0; s < nracers; s++)
        if (racers[s] == id) return s;
    int slot = nracers;
    for (int i = 0; i < nmembers; i++) {
        int racing = 0;
        for (int s = 0; s < nracers; s++) racing |= racers[s] == members[i];
        if (racing) continue;
        if (members[i] == id) return slot;
        slot++;
    }
    return -1;
}

#endif
