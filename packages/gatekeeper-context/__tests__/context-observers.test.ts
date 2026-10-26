import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ContextCollectionDurableObject } from "../src/context-collection.js";
import {
  collectionSubresource, deniedCollectionSubresources, forgetLegacyObserver,
  legacyCollectionSubresources,
} from "../src/context-observers.js";
import { domainName } from "../src/domain.js";

// The miniflare bindings vitest.config.ts declares, which Cloudflare.Env does not.
const testEnv = env as unknown as { COLLECTIONS: DurableObjectNamespace<ContextCollectionDurableObject> };
const collections = testEnv.COLLECTIONS;

// Storage persists across the file's tests, so each gets its own sharing domain.
let domain = "";
let domains = 0;
beforeEach(() => {
  domain = `observers-${domains++}.example`;
});

const collection = (id: string) => collections.get(collections.idFromName(domainName(domain, id)));

async function createCollection(id: string, visibility: "private" | "public", owner = "alice") {
  let now = new Date();
  await collection(id).initialize({
    id, title: id, description: "", visibility,
    created: now, lastUpdated: now, documentCount: 0, content: { source: "web" },
  }, domain, visibility === "private" ? owner : "");
}

const denied = (accountId: string, subresources: string[]) =>
  deniedCollectionSubresources(collections, domain, accountId, subresources);

describe("deniedCollectionSubresources", () => {
  it("grants exactly the collections the account can read now", async () => {
    await createCollection("shared", "private");
    await collection("shared").share("alice", [{ accountId: "bob", displayName: "bob" }], "viewer");
    await createCollection("everyone", "private");
    await collection("everyone").setEveryoneCanView("alice", true);
    await createCollection("public", "public");
    await createCollection("unshared", "private");
    await createCollection("deleted", "private");
    await collection("deleted").removeAccount("alice");

    let readable = ["shared", "everyone", "public"].map(id => collectionSubresource(domain, id));
    let unreadable = [
      ...["unshared", "deleted", "never-created"].map(id => collectionSubresource(domain, id)),
      // Another sharing domain's collection, even one with this ID.
      collectionSubresource("elsewhere.example", "public"),
      JSON.stringify(["document", domain, "public"]),
      "not a subresource",
    ];
    expect((await denied("bob", [...readable, ...unreadable])).toSorted()).toEqual(unreadable.toSorted());
    expect(await denied("alice", [collectionSubresource(domain, "unshared")])).toEqual([]);
  });

  it("denies a collection as soon as the account's access to it is revoked", async () => {
    await createCollection("shared", "private");
    await collection("shared").share("alice", [{ accountId: "bob", displayName: "bob" }], "viewer");
    let shared = collectionSubresource(domain, "shared");
    expect(await denied("bob", [shared])).toEqual([]);

    await collection("shared").removeMember("alice", "bob");

    expect(await denied("bob", [shared, shared])).toEqual([shared, shared]);
  });
});

describe("legacyCollectionSubresources", () => {
  it("exports every collection the gatekeeper's own tracker recorded, whatever its state", async () => {
    // The layout the tracker left in a binding's storage: one marker per collection a read revealed,
    // beside each admitted observer's registration.
    let storage = new Map<string, unknown>([
      ["observedCollection:unshared", true],
      ["observedCollection:shared", "observed"],
      ["observedCollection:uncertain", "pending"],
      ["observer:collaborator", { verifier: "stub" }],
      ["observer-attempt:candidate", { verifier: "stub", at: 0 }],
      ["observer-nonce:candidate", "nonce"],
    ]);
    let kv = {
      list: ({ prefix = "" }: SyncKvListOptions = {}) =>
        [...storage].filter(([key]) => key.startsWith(prefix)).values(),
      delete: (key: string) => storage.delete(key),
    } as Pick<SyncKvStorage, "list" | "delete">;
    await createCollection("unshared", "private");
    await createCollection("shared", "private");
    await collection("shared").share("alice", [{ accountId: "bob", displayName: "bob" }], "viewer");
    await createCollection("uncertain", "private");

    // Retiring the tracker's registrations leaves the history to export again if the import fails.
    forgetLegacyObserver(kv, "collaborator");
    forgetLegacyObserver(kv, "candidate");
    let exported = legacyCollectionSubresources(kv, domain);

    expect(exported.toSorted()).toEqual(
      ["shared", "uncertain", "unshared"].map(id => collectionSubresource(domain, id)).toSorted());
    expect([...storage.keys()].every(key => key.startsWith("observedCollection:"))).toBe(true);
    expect((await denied("bob", exported)).toSorted()).toEqual(
      ["uncertain", "unshared"].map(id => collectionSubresource(domain, id)).toSorted());
    expect(await denied("alice", exported)).toEqual([]);
  });
});
