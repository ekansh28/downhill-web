/* The room chat's JOINED / LEFT notes (client.c note_members, finding 204): none for the room as
   this player found it, one for each member who comes or goes after that, none for this player
   and none when nothing changed. No server or game data. */
#include "client.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static void text(void *ctx, const char *s) { (void)ctx; (void)s; }
static void binary(void *ctx, const void *s, size_t n) { (void)ctx; (void)s; (void)n; }

/* A room message listing these members (id and name). */
static void room(NetClient *c, const char *members)
{
    char t[1024];
    snprintf(t, sizeof t, "{\"type\":\"room\",\"hostId\":1,\"settings\":{\"track\":3,\"laps\":2},\"members\":[%s]}", members);
    client_on_text(c, t, strlen(t));
}

static int notes(const NetClient *c) { return c->chat.count; }
static const char *last(const NetClient *c) { return c->chat.line[c->chat.count - 1].text; }

int main(void)
{
    NetClient c;
    NetTransport t;
    const char *welcome = "{\"type\":\"welcome\",\"memberId\":2,\"code\":\"TEST22\",\"serverTime\":1000}";
    client_init(&c, "Me", "test", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    memset(&t, 0, sizeof t); t.send_text = text; t.send_binary = binary;
    client_connected(&c, &t);
    client_on_text(&c, welcome, strlen(welcome));

    /* the room as found: no notes, not even for this player */
    room(&c, "{\"id\":1,\"name\":\"Host\"},{\"id\":2,\"name\":\"Me\"}");
    assert(notes(&c) == 0);
    /* the same again: nothing */
    room(&c, "{\"id\":1,\"name\":\"Host\"},{\"id\":2,\"name\":\"Me\"}");
    assert(notes(&c) == 0);
    /* someone comes */
    room(&c, "{\"id\":1,\"name\":\"Host\"},{\"id\":2,\"name\":\"Me\"},{\"id\":5,\"name\":\"Ada\"}");
    assert(notes(&c) == 1 && !strcmp(last(&c), "Ada JOINED THE ROOM"));
    assert(c.chat.line[0].member_id == NET_CHAT_ROOM && c.chat.line[0].seq == 1);
    /* the host goes and another comes in one message: two notes */
    room(&c, "{\"id\":2,\"name\":\"Me\"},{\"id\":5,\"name\":\"Ada\"},{\"id\":6,\"name\":\"Bo\"}");
    assert(notes(&c) == 3 && !strcmp(c.chat.line[1].text, "Bo JOINED THE ROOM") && !strcmp(last(&c), "Host LEFT THE ROOM"));
    room(&c, "{\"id\":2,\"name\":\"Me\"},{\"id\":5,\"name\":\"Ada\"},{\"id\":6,\"name\":\"Bo\"}");
    assert(notes(&c) == 3);

    /* a new room (client_init): its first message is the room as found again */
    client_free(&c);
    client_init(&c, "Me", "test", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    client_connected(&c, &t);
    client_on_text(&c, welcome, strlen(welcome));
    room(&c, "{\"id\":7,\"name\":\"Cy\"},{\"id\":2,\"name\":\"Me\"}");
    assert(notes(&c) == 0);
    puts("test_room_notes: ok");
    return 0;
}
