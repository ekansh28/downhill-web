/* The browser's network module (port/web/build_net.py): what www/net.js needs besides net.c's
   host_service_net_* exports, which take this module's own addresses (GUEST is the identity on
   wasm32). net.js copies a NetLobby, NetLobbyInfo or NetChat from here into the game's memory as is: both
   modules are wasm32, so the layouts agree. */
#include "../../net/net.h"

/* net.js reads these fields of the copy where they are here: the join code and the track */
_Static_assert(offsetof(NetLobby, code) == 8 && offsetof(NetLobby, track) == 140, "NetLobby moved: update net.js host_service_net_get_lobby");

int web_net_lobby_size(void) { return (int)sizeof(NetLobby); }
int web_net_info_size(void) { return (int)sizeof(NetLobbyInfo); }
int web_net_chat_size(void) { return (int)sizeof(NetChat); }
