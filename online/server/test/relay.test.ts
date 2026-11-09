import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Client } from "./helpers";

// Relay races (this fork, RACE_TRANSPORT "auto"): a race goes over the room's sockets when the
// server has no Realtime credentials, a racer's game has no WebRTC (no_sfu) or a racer's session
// isn't connected at the start; else over Realtime, as upstream's (the other tests pin "sfu").

type Setup = { transport?: string; credentials?: boolean; connected?: boolean };

/** A room in the given transport mode, with racers P0..P(n-1) (extra(i) in each hello), started. */
async function race(n: number, setup: Setup, extra: (i: number) => object = () => ({})) {
  const { host, code } = await Client.host("P0", extra(0));
  const stub = env.ROOM.get(env.ROOM.idFromName(code));
  await runInDurableObject(stub, async (room: any) => {
    room.env = {
      ...room.env, RACE_TRANSPORT: setup.transport ?? "auto",
      ...(setup.credentials ? { REALTIME_APP_ID: "app", REALTIME_APP_TOKEN: "token" } : {}),
    };
  });
  const clients = [host];
  for (let i = 1; i < n; i++) clients.push(await Client.join(code, `P${i}`, extra(i)));
  if (setup.connected)
    await runInDurableObject(stub, async (room: any) => {
      for (const m of room.state.members) m.sfuConnected = true;
    });
  for (const c of clients) c.sendJson({ type: "ready", ready: true });
  await host.next((f) => typeof f === "string" && JSON.parse(f).type === "room" &&
    JSON.parse(f).members.length === n && JSON.parse(f).members.every((m: any) => m.ready));
  host.sendJson({ type: "start" });
  const starts = await Promise.all(clients.map((c) => c.json("start")));
  const bySlot: Client[] = [];
  starts.forEach((s, i) => (bySlot[s.yourSlot] = clients[i]));
  return { clients: bySlot, starts, joiners: clients.slice(1) };
}

describe("relay races (RACE_TRANSPORT auto)", () => {
  it("without Realtime credentials: the welcome says sfu off and the race is relayed", async () => {
    const { clients, starts, joiners } = await race(2, {});
    for (const j of joiners) expect(j.welcome.sfu).toBe("off");
    for (const s of starts) expect(s.transport).toBe("relay");
    clients[0].ws.send(new Uint8Array([5, 9, 1, 2, 3]).buffer);
    clients[0].ws.send(new Uint8Array([6, 9, 4]).buffer);
    // the room stamps the sender's slot (byte 1) and keeps the order
    expect([...(await clients[1].binary())]).toEqual([5, 0, 1, 2, 3]);
    expect([...(await clients[1].binary())]).toEqual([6, 0, 4]);
    // and nothing comes back to the sender
    await expect(clients[0].next((f) => typeof f !== "string", 100)).rejects.toThrow("timed out");
  });

  it("relays a whole race's rate of frames without the guard's too_fast", async () => {
    const { clients } = await race(2, {});
    for (let i = 0; i < 400; i++) clients[0].ws.send(new Uint8Array([5, 0, i & 255]).buffer);
    let got = 0;
    while (got < 400) {
      const b = await clients[1].binary();
      expect(b[2]).toBe(got & 255);
      got++;
    }
    await expect(clients[0].next((f) => typeof f === "string" && JSON.parse(f).type === "error", 100)).rejects.toThrow("timed out");
  });

  it("with credentials, a racer without WebRTC (no_sfu) makes the race a relay race", async () => {
    const { clients, starts, joiners } = await race(2, { credentials: true, connected: true },
      (i) => (i === 1 ? { features: ["countdown", "session", "no_sfu"] } : {}));
    expect(joiners[0].welcome.sfu).toBe("off");
    for (const s of starts) expect(s.transport).toBe("relay");
    clients[1].ws.send(new Uint8Array([5, 7, 42]).buffer);
    expect([...(await clients[0].binary())]).toEqual([5, 1, 42]);
  });

  it("with credentials, a racer whose session isn't connected makes the race a relay race", async () => {
    const { starts } = await race(2, { credentials: true, connected: false });
    for (const s of starts) expect(s.transport).toBe("relay");
  });

  it("with credentials and every session connected, the race goes over Realtime", async () => {
    const { clients, starts } = await race(2, { credentials: true, connected: true });
    for (const s of starts) expect(s.transport).toBe("sfu");
    clients[0].ws.send(new Uint8Array([5, 0, 7]).buffer);
    clients[0].ws.send(new Uint8Array([3, 0, 42]).buffer);
    expect([...(await clients[0].binary()).slice(0, 3)]).toEqual([4, 0, 42]);
    await expect(clients[1].next((f) => typeof f !== "string", 100)).rejects.toThrow("timed out");
  });

  it("RACE_TRANSPORT relay relays even with credentials and connected sessions", async () => {
    const { starts } = await race(2, { transport: "relay", credentials: true, connected: true });
    for (const s of starts) expect(s.transport).toBe("relay");
  });
});
