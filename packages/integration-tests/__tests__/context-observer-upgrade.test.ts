// The Context Library's observer tracking carried across the upgrade that moves it into the
// Workshop: a workspace reads a private collection under the release before this one, whose
// gatekeeper recorded the collection itself, and after the upgrade the Workshop imports that record
// (`getHistoricalSubresources()`) and verifies collaborators against it. The release before is main
// as it was before the move, built by `build:upgrade-base`, and the upgrade is wrangler's
// storage-preserving `update()`.

import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { ContextLibrary } from "../../gatekeeper-context/src/context-types.js";
import { settleRestart, startHarness, type Harness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { MAX_OBSERVER_PROMPTS, ObserverConfigRecorder, stubFor } from "../src/rpc-client.js";
import {
  baseContextGatekeeper, CONTEXT_VENDOR_ID, contextUser, DOCUMENT, newContextUser, privateWorkspace,
  upgradeContext,
} from "./context-fixtures.js";

/** The Workshop's refusal of an account that cannot read what a tracked connection recorded. */
const DENIED = "This account can't access some of the data this workspace read through this service.";

let harness: Harness;
const network = new NetworkInterceptor({ handlers: [] });

beforeAll(async () => {
  network.install();
  harness = await startHarness({ gatekeepers: [baseContextGatekeeper()] });
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

it("verifies collaborators against collections the workspace read before the upgrade", async () => {
  using stack = new DisposableStack();

  // ── Under the release before this one ──────────────────────────────────────────────────────
  const ownerBefore = stack.use(await newContextUser(harness, "contextupgradeowner"));
  const observerBefore = stack.use(await newContextUser(harness, "contextupgradeobserver"));
  const state = stack.use(await privateWorkspace(ownerBefore));
  const { collection, workspaceId, docId } = state;
  expect(await state.session.read(docId)).toMatchObject({ content: DOCUMENT.body });
  await state.workspace.addCollaborator(observerBefore.username, "build");

  // ── The upgrade ─────────────────────────────────────────────────────────────────────────────
  await upgradeContext(harness);

  // ── Under this tree's release ───────────────────────────────────────────────────────────────
  const owner = stack.use(await contextUser(harness, ownerBefore.username, true));
  const observer = stack.use(await contextUser(harness, observerBefore.username, true));
  const recorder = new ObserverConfigRecorder()
    .alwaysChoose(observer.account.id, MAX_OBSERVER_PROMPTS);
  const callback = stack.use(stubFor(recorder));

  // No read since the upgrade, so only the imported record can refuse the collaborator.
  await expect(observer.api.openGadget(workspaceId, undefined, callback)).rejects.toThrow(DENIED);
  const failure = recorder.needAt(0).failure;
  expect(failure).toMatchObject({ accountId: observer.account.id, reason: expect.stringContaining(DENIED) });
  expect(failure?.reason).not.toContain(collection.id);
  expect(failure?.reason).not.toContain(collection.title);
  // The import restarts the workspace's sessions: let that land before anyone opens it again.
  await settleRestart();
  const workspace = stack.use(await owner.api.openGadget(workspaceId));
  const { entries } = await workspace.listActions({ filter: "observation" });
  expect(entries.map(entry => entry.description.title)).toContain("Imported earlier reads");

  // The imported collection is checked live, like one read since.
  await owner.context.setContextCollectionEveryoneCanView(collection.id, true);
  const opened = stack.use(await observer.api.openGadget(workspaceId, undefined, callback));
  expect(await opened.getMetadata()).toMatchObject({ id: workspaceId, role: "build" });

  // The upgraded connection reads on, now tracked by the Workshop.
  const requirement = (await workspace.listObserverRequirements("build"))
    .find(entry => entry.vendorId === CONTEXT_VENDOR_ID);
  if (!requirement) throw new Error("The workspace lost its ambient Context binding");
  const binding = stack.use(await workspace.getGatekeeperById(requirement.gatekeeperId));
  const session = stack.use(await binding.openSession() as RpcStub<ContextLibrary>);
  expect(await session.read(docId)).toMatchObject({ content: DOCUMENT.body });
});
