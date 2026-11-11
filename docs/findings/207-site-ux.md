# 207: the site's home page and menu in plain words

Status: current
Checked: 2026-11-11

Branch `web/ux` (after finding 205). `port/web/www/index.html`, `main.js`.

## Goal and acceptance

A first-time player, on a laptop or a phone, or a friend opening an invite link, sees what to do
and what went wrong without the log. Kept as they were: 98.css, only the site's Play button on the
deployed site, the username on the home page, Ko-fi, Dev notes, the GPU tip, the access code.

## Decisions

1. **A problem box** says in plain words why this browser can't play (no cross-origin isolation, no
   JSPI with the iOS case, no WebGPU) and what to do; the page still lays out (plain buffers when
   not isolated) and the buttons stay off.
2. **An invite link says so**: "You are invited to room CODE", Play reads "Play and join the
   room", and the access-code note explains where the code is in the friend's link.
3. **The access code check** tells an empty field, a malformed code, a wrong code (404) and a site
   that didn't answer apart, and puts the cursor back in the field.
4. **Keyboard**: the cursor starts in the username (not on touch screens); Enter plays (or moves to
   the access code). The name box asks for a name only after a Play press without one.
5. **Controls and keys** on the home page opens the menu on Controls, which now lists V (hold to
   talk, the default DHD_VOICE_KEY), Y (race chat) and ` (the menu).
6. **Plain status**: "60 fps, picture WxH"; the technical line goes to the log once a minute
   (window.dhdStatus keeps the whole report for the checks). The download line says what is
   downloading, how much, and that the room's track comes first. A stopped game says so, opens the
   log and offers "Reload the page". No microphone, a denied microphone and a lost network show a
   note over the game.
7. **Dev notes fold** with the window's minimize button (remembered in this browser). On a phone the
   page leaves room under the last window for the Support me button.

## Checks

- `node --check` on main.js; headless Edge at 1280x800 and 390x844 (also with `?room=`): no
  horizontal scroll, the cursor in the username, the invite note shown, Controls and keys opens the
  help, no script errors (the one 404 is site.json, served only by the deployed site).

## What is left

- Not reached headless: the problem box on a browser without WebGPU, a real microphone denial, the
  game's stop screen; the deployed site's own layout (site.json) is checked after the deploy.
