import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Client, startedRace } from "./helpers";

// Room.inviteCard: what an invite link's preview says about the room (port/web/host's invitePage).
const card = (code: string) =>
  (env.ROOM.get(env.ROOM.idFromName(code)) as unknown as { inviteCard(): Promise<unknown> }).inviteCard();

describe("invite card", () => {
  it("names the host and counts the riders", async () => {
    const { code } = await Client.host("Ekansh");
    await Client.join(code, "Bo");
    expect(await card(code)).toEqual({ host: "Ekansh", players: 2, max: expect.any(Number), racing: false });
  });

  it("says when a race runs", async () => {
    const { code } = await startedRace(2);
    expect(await card(code)).toMatchObject({ host: "P0", players: 2, racing: true });
  });

  it("is null for a code no room has", async () => {
    expect(await card("ZZZZZ9")).toBeNull();
  });
});
