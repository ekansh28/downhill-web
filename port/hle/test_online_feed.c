/* online_feed.h (finding 204): the race feed's places and the room list's voice slots. */
#include "online_feed.h"
#include <assert.h>
#include <string.h>

static const char *ordinal(int place)
{
    static char text[16];
    feed_ordinal(text, sizeof text, place);
    return text;
}

int main(void)
{
    assert(!strcmp(ordinal(1), "1ST") && !strcmp(ordinal(2), "2ND") && !strcmp(ordinal(3), "3RD"));
    assert(!strcmp(ordinal(4), "4TH") && !strcmp(ordinal(10), "10TH") && !strcmp(ordinal(11), "11TH"));
    assert(!strcmp(ordinal(12), "12TH") && !strcmp(ordinal(13), "13TH") && !strcmp(ordinal(21), "21ST"));
    assert(!strcmp(ordinal(22), "22ND") && !strcmp(ordinal(111), "111TH"));

    /* places by time; the unfinished don't count; a tie goes to the lower rider */
    int finish[5] = {5000, -1, 4000, 5000, 6000};
    assert(feed_place(finish, 5, 2) == 1 && feed_place(finish, 5, 0) == 2 && feed_place(finish, 5, 3) == 3);
    assert(feed_place(finish, 5, 4) == 4 && feed_place(finish, 5, 1) == 0 && feed_place(finish, 5, 7) == 0);

    /* no race: the member list's index */
    int members[4] = {7, 3, 9, 12};
    assert(feed_voice_slot(7, members, 4, 0, -1) == 0 && feed_voice_slot(12, members, 4, 0, -1) == 3);
    assert(feed_voice_slot(5, members, 4, 0, -1) == -1);
    /* a race of 9 (the host, slot 0) and 3; 7 and 12 watch from the room, after the racers */
    int racers[2] = {9, 3};
    assert(feed_voice_slot(9, members, 4, racers, 2) == 0 && feed_voice_slot(3, members, 4, racers, 2) == 1);
    assert(feed_voice_slot(7, members, 4, racers, 2) == 2 && feed_voice_slot(12, members, 4, racers, 2) == 3);
    /* a racer who left the room keeps its slot: the watchers still come after every slot */
    int left[3] = {9, 44, 3};
    assert(feed_voice_slot(3, members, 4, left, 3) == 2 && feed_voice_slot(7, members, 4, left, 3) == 3);
    assert(feed_voice_slot(44, members, 4, left, 3) == 1 && feed_voice_slot(5, members, 4, left, 3) == -1);
    return 0;
}
