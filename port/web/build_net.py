"""The browser's online modules (findings 190, 196), wasm32 reactors with their own memories:

- build/web/dhd_net.wasm, port/net's lobby client (client.c, json.c, join.c, net.c), the C the
  native game links. It runs in the game worker (www/net.js), so the game's host_service_net_*
  stay synchronous calls.
- build/web/dhd_voice.wasm, voice chat: port/host/voice.c and libopus (port/tools/opus.py
  wasm_objects; finding 183). It runs in the net worker (www/net_worker.js) beside the WebSocket,
  in real time whatever the game worker is doing.

    python port/web/build_net.py

dhd_net imports env.ws_start, ws_send, ws_stop and http_get (ws.h, implemented by www/net.js over
the net worker's WebSocket and its own fetch), env.web_now_ns (its clock,
port/web/net/SDL3/SDL_timer.h) and WASI's fd_write and environ (its log lines, getenv). It exports
net.c's host_service_net_* (their addresses are this module's: GUEST is the identity on wasm32),
net_web.c's struct sizes, malloc and the function table, through which net.js calls a ws.h
handler's callbacks. The client runs on the game worker's one thread, so port/web/net/SDL3's locks
do nothing.

dhd_voice imports env.web_now_ns, web_getenv, web_key_held, web_net_voice_open and web_net_send
(port/web/net/voice_web.c) and WASI's fd_write; it exports voice.c's host_service_voice_*, the mix
and the microphone's entry points. It too runs on one thread (the net worker's)."""
import os,subprocess,sys
from pathlib import Path
DEVCACHES = Path(os.environ.get('DHD_DEVCACHES') or Path.home() / 'DevCaches')  # downloaded tools and caches
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'build/web'
WASI=DEVCACHES/'wasi-sdk/wasi-sdk-34.0-x86_64-windows'
NET_SOURCES=[ROOT/'port/net'/n for n in ('client.c','json.c','join.c','net.c')]+[ROOT/'port/web/net/net_web.c']
NET_EXPORTS=['host_service_net_'+n for n in ('init','create_room','join_room','leave','get_lobby','pick','set_ready','start_race',
         'racing','seconds','server_ms','send_frame','receive_frame','list_lobbies','set_room',
         'send_chat','get_chat',
         'finish','back','rules','rotation','end_race')]+['net_local_slot','net_voice_open','web_net_lobby_size','web_net_info_size','web_net_chat_size','malloc','free']
VOICE_SOURCES=[ROOT/'port/host/voice.c',ROOT/'port/web/net/voice_web.c']
# voice chat (voice.c): the game's host_service_voice_*, the mix, the page's microphone
VOICE_EXPORTS=['host_service_voice_'+n for n in ('frame','place','mute','drop','state')]+['voice_open','voice_mix',
         'voice_web_wanted','voice_web_mic','voice_web_capture','malloc','free']
def link(out,sources,exports,extra=(),flags=()):
    cmd=[str(WASI/'bin/clang'),'--target=wasm32-wasip1','--sysroot='+str(WASI/'share/wasi-sysroot'),'-mexec-model=reactor','-O2',
         '-Wall','-Wno-unused-function',*flags,'-I',str(ROOT/'port/web/net'),
         '-I',str(ROOT/'port/include'),*map(str,sources),*map(str,extra),'-o',str(out),
         '-Wl,--allow-undefined','-Wl,--export-table','-Wl,--no-entry',*['-Wl,--export='+e for e in exports]]
    env=dict(os.environ,TEMP=str(out.parent),TMP=str(out.parent))
    subprocess.run(cmd,check=True,env=env,cwd=ROOT)
def build(out=OUT/'dhd_net.wasm'):
    """dhd_net.wasm at out, dhd_voice.wasm beside it; returns out."""
    out.parent.mkdir(parents=True,exist_ok=True)
    sys.path.insert(0,str(ROOT/'port/tools'))
    import opus
    opus_objects,opus_include=opus.wasm_objects(WASI/'bin/clang.exe',WASI/'share/wasi-sysroot')
    link(out,NET_SOURCES,NET_EXPORTS)
    link(out.parent/'dhd_voice.wasm',VOICE_SOURCES,VOICE_EXPORTS,opus_objects,['-DDHD_VOICE=1','-DDHD_VOICE_WEB=1','-I',str(opus_include)])
    return out
if __name__=='__main__':print(build())
