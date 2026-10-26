// Kernel-owned observer tracking for the Context Library (docs/observers.md §10). Collections are the
// unit: every document and skill in one inherits its access, so a read depends on each collection
// whose contents it revealed. The Workshop records those collections and asks each collaborator's
// own verifier whether they can still read them.

import type { GatekeeperUserVerifier } from "@gadgets/workshop-shared/gatekeeper";
import { canReadCollection } from "./collection-access.js";
import type { ContextCollectionDurableObject } from "./context-collection.js";
import { MAX_COLLECTION_FANOUT, mapWithConcurrency } from "./concurrency.js";
import { domainName } from "./domain.js";

/**
 * A Context account's verifier. The overseer only passes a verifier back to the vendor that minted
 * it, so the management API may trust `getAccountId()`.
 */
export interface ContextVerifierApi extends GatekeeperUserVerifier {
  /** Denies each collection subresource this account cannot read now. */
  verifyObserverAccess(subresources: string[]): Promise<{ denied: string[] }>;
  /**
   * The account's ID, so a collection can be shared with the person a user-picker ticket names.
   * Null for any other sharing domain, which this account has no collections in.
   */
  getAccountId(sharingDomain: string): Promise<string | null>;
}

/**
 * The subresource a read revealing `collectionId`'s contents depends on. It names the sharing domain
 * too, since collection IDs are only unique within one. A JSON tuple, so no pair of strings can
 * spell another pair's ID.
 */
export function collectionSubresource(sharingDomain: string, collectionId: string): string {
  return JSON.stringify(["collection", sharingDomain, collectionId]);
}

function parseCollectionSubresource(subresource: string):
    { sharingDomain: string; collectionId: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(subresource);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[0] !== "collection") return null;
  let sharingDomain: unknown = parsed[1], collectionId: unknown = parsed[2];
  if (typeof sharingDomain !== "string" || typeof collectionId !== "string" || !collectionId) {
    return null;
  }
  return { sharingDomain, collectionId };
}

/**
 * The subresources `accountId` cannot read now: collections it has no access to under
 * `collection-access.ts`, collections in another sharing domain, and anything that is not a
 * collection subresource. Throws when a collection cannot be asked, which the Workshop treats as a
 * denial.
 */
export async function deniedCollectionSubresources(
    collections: DurableObjectNamespace<ContextCollectionDurableObject>,
    sharingDomain: string, accountId: string, subresources: string[]): Promise<string[]> {
  let denied: string[] = [];
  let byCollection = new Map<string, string[]>();
  for (let subresource of subresources) {
    let parsed = parseCollectionSubresource(subresource);
    if (!parsed || parsed.sharingDomain !== sharingDomain) {
      denied.push(subresource);
      continue;
    }
    let named = byCollection.get(parsed.collectionId);
    if (named) named.push(subresource);
    else byCollection.set(parsed.collectionId, [subresource]);
  }
  let collectionIds = [...byCollection.keys()];
  let readable = await mapWithConcurrency(collectionIds, MAX_COLLECTION_FANOUT, async collectionId =>
    canReadCollection(await collections.get(
      collections.idFromName(domainName(sharingDomain, collectionId))).getAccess(accountId)));
  collectionIds.forEach((collectionId, index) => {
    if (!readable[index]) denied.push(...byCollection.get(collectionId)!);
  });
  return denied;
}

// Where the gatekeeper's own tracker recorded each collection a read revealed, before the Workshop
// tracked observations. Never deleted: a binding upgrades whenever its workspace next uses it, and
// its export may be asked for again until the Workshop commits the import.
const LEGACY_COLLECTION_PREFIX = "observedCollection:";

// Where that tracker kept each admitted observer's verifier, and each admission in flight.
const LEGACY_OBSERVER_PREFIXES = ["observer:", "observer-attempt:", "observer-nonce:"];

/**
 * Every collection the binding's reads revealed before the Workshop tracked them, as subresources.
 * A marker of any state counts: a "pending" one belongs to a read whose authorization outcome was
 * never learned, so the Workshop may have recorded it.
 */
export function legacyCollectionSubresources(
    kv: Pick<SyncKvStorage, "list">, sharingDomain: string): string[] {
  return Array.from(kv.list({ prefix: LEGACY_COLLECTION_PREFIX }), ([key]) =>
    collectionSubresource(sharingDomain, key.slice(LEGACY_COLLECTION_PREFIX.length)));
}

/** Drops the verifier and any admission attempt the binding's tracker kept for `observerId`. */
export function forgetLegacyObserver(kv: Pick<SyncKvStorage, "delete">, observerId: string): void {
  for (let prefix of LEGACY_OBSERVER_PREFIXES) kv.delete(prefix + observerId);
}
