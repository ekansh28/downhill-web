import { describe, expect, it } from "vitest";
import { Client, startedRace } from "./helpers";

// Voice chat anywhere in a room (FRAME_VOICE = 7, room.ts relayVoice): every other member gets it,
// racing or not, byte 1 the sender's voice slot.
const voice = (seq: number) => new Uint8Array([7, 9, 2, 11, seq, 0, 1, 2, 3]).buffer;

describe("voice anywhere in the room", () => {
  it("reaches everyone in the lobby, before any race, slot = place in the room", async () => {
    const { host, code } = await Client.host("Ann");
    const bo = await Client.join(code, "Bo");
    const cy = await Client.join(code, "Cy");
    bo.ws.send(voice(1));
    for (const c of [host, cy]) expect([...(await c.binary())].slice(0, 5)).toEqual([7, 1, 2, 11, 1]);
    await expect(bo.next((f) => typeof f !== "string", 100)).rejects.toThrow("timed out");
  });

  it("in an SFU race the racers hear each other over the SFU: the room doesn't copy it to them", async () => {
    const { clients } = await startedRace(3);  // the tests' RACE_TRANSPORT: sfu
    clients[2].ws.send(voice(2));
    for (const c of [clients[0], clients[1]]) await expect(c.next((f) => typeof f !== "string", 150)).rejects.toThrow("timed out");
  });

  it("50 frames a second for a few seconds without the guard's too_fast", async () => {
    const { host, code } = await Client.host("Ann");
    const bo = await Client.join(code, "Bo");
    for (let s = 0; s < 3; s++) {  // a microphone's pace: 50 a second
      for (let i = 0; i < 50; i++) bo.ws.send(voice((s * 50 + i) & 255));
      if (s < 2) await new Promise((r) => setTimeout(r, 1000));
    }
    for (let i = 0; i < 150; i++) expect((await host.binary())[4]).toBe(i & 255);
    await expect(bo.next((f) => typeof f === "string" && JSON.parse(f).type === "error", 100)).rejects.toThrow("timed out");
  });

  it("a flood is cut at 75 a second, and only voice.c's packets pass", async () => {
    const { host, code } = await Client.host("Ann");
    const bo = await Client.join(code, "Bo");
    bo.ws.send(new Uint8Array([7, 9, 1, 11, 0, 0, 1, 2]).buffer);  // not voice.c's version: dropped
    for (let i = 0; i < 200; i++) bo.ws.send(voice(i & 255));
    for (let i = 0; i < 75; i++) expect((await host.binary())[4]).toBe(i & 255);
    await expect(host.next((f) => typeof f !== "string", 300)).rejects.toThrow("timed out");
  });
});
