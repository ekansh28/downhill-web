/* Voice chat in the browser (findings 183, 196): port/host/voice.c is built with libopus for wasm32
   (port/tools/opus.py wasm_objects) into its own module, build/web/dhd_voice.wasm
   (port/web/build_net.py, DHD_VOICE_WEB), which runs in the net worker (www/net_worker.js), never
   in the game worker: the others' voices are decoded and mixed there in real time for the page's
   dhd-voice worklet, and the page's microphone is encoded there 20 ms at a time
   (voice_web_capture) and sent on the net worker's socket. voice.c's hearing side runs as it does
   natively, its packets straight from the socket. What voice.c asks of the native host and of
   port/net comes from the net worker here: the settings (the game's live environment, so PC
   SETTINGS applies at once), the push-to-talk key (the page's keys, not while a text field has
   them), whether the game is racing, the frame sent, and the log. */
#include <stdarg.h>
#include <stddef.h>
#include <stdio.h>
#include <stdint.h>

__attribute__((import_module("env"), import_name("web_getenv"))) int web_getenv(const char *name, char *out, int cap);
__attribute__((import_module("env"), import_name("web_key_held"))) int web_key_held(unsigned key);
__attribute__((import_module("env"), import_name("web_net_racing"))) int web_net_racing(void);
__attribute__((import_module("env"), import_name("web_net_send"))) int web_net_send(int type, const void *payload, int n);

/* host_api.h's host_getenv: the game's value now. A few calls' answers stay valid at once
   (voice.c reads its settings one after another). */
const char *host_getenv(const char *name)
{
    static char values[8][160];
    static unsigned next;
    char *out = values[next++ % 8];
    return web_getenv(name, out, (int)sizeof values[0]) ? out : NULL;
}

void hle_log(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    vfprintf(stderr, fmt, ap);   /* the net worker prints the module's stderr in the page's log */
    va_end(ap);
}

/* The page's keys (as worker.js host_service_key_held: a text field open holds them all). */
int keyboard_focused(void) { return 1; }
int keyboard_is_down(unsigned typed) { return web_key_held(typed); }
int text_input_active(void) { return 0; }

/* net.h, as voice.c uses it: the client is in the game worker, so the net worker answers. */
void (*net_voice_hook)(int slot, const uint8_t *payload, int n);
int net_racing(void) { return web_net_racing(); }
int net_send_frame(int type, const void *payload, size_t n) { return web_net_send(type, payload, (int)n); }
