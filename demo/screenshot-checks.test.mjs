import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PAGE_TITLE, assertFrame, assertFullWidthClip, assertImageSize, assertIsolatedSession, assertSyntheticIdentity, pngSize } from "./screenshot-checks.mjs";

const REPOSITORY = "RamrattanN/canvas-demo";
const clip = { x: 0, y: 0, width: 1600, height: 900 };
const rect = (x, y, width, height) => ({ x, y, width, height });
const frame = (overrides = {}) => ({
  header: rect(0, 0, 1600, 64), brandLogo: rect(28, 10, 32, 40), brandLogoLoaded: true, projectLogo: rect(28, 117, 48, 48), projectLogoLoaded: true,
  title: rect(90, 120, 730, 40), titleText: PAGE_TITLE, controls: { "repository selector": true }, ...overrides,
});
const page = (overrides = {}) => ({
  account: "Signed in as orbitron-demo · 1 repository", repositoryOptions: [REPOSITORY], cardKeys: [`${REPOSITORY}#2`],
  links: [`https://github.com/${REPOSITORY}/issues/2`], text: "Orbitron Sprocket Works", ...overrides,
});

test("committed screenshots share the approved overview width", () => {
  for (const name of ["01-board-overview.png", "02-repository-and-account.png", "03-planning-cards.png", "04-done-merged-prs.png", "05-search-filters-card-limit.png"]) {
    const size = pngSize(readFileSync(new URL(`../docs/demo/images/${name}`, import.meta.url)));
    assert.equal(size.width, 3814, `${name} width`);
    assert.ok(size.height >= 300, `${name} includes the header and title`);
  }
  assert.throws(() => pngSize(Buffer.from("not an image at all, not a png")), /not a PNG/);
});

test("clips must start at the page origin and span the viewport", () => {
  assertFullWidthClip("ok", clip, 1600, 2000);
  assert.throws(() => assertFullWidthClip("lane", { ...clip, x: 1300, width: 265 }, 1600, 2000), /left edge/);
  assert.throws(() => assertFullWidthClip("summary", { ...clip, y: 340 }, 1600, 2000), /top of the page/);
  assert.throws(() => assertFullWidthClip("tall", { ...clip, height: 2500 }, 1600, 2000), /inside the page/);
});

test("image size must match the clip at the device scale", () => {
  assertImageSize("ok", { width: 3814, height: 1688 }, { x: 0, y: 0, width: 2034, height: 900 }, 1.875);
  assert.throws(() => assertImageSize("cropped", { width: 3814, height: 1200 }, { x: 0, y: 0, width: 2034, height: 900 }, 1.875), /height/);
  assert.throws(() => assertImageSize("unscaled", { width: 2034, height: 1688 }, { x: 0, y: 0, width: 2034, height: 900 }, 1.875), /width/);
});

test("frame check requires the full header, both logos, the title, and requested controls", () => {
  assertFrame("ok", frame(), clip);
  assert.throws(() => assertFrame("cropped", frame(), { ...clip, y: 100 }), /application header/);
  assert.throws(() => assertFrame("logo", frame({ projectLogoLoaded: false }), clip), /Orbitron logo/);
  assert.throws(() => assertFrame("title", frame({ titleText: "Project Delivery Board" }), clip), /project title/);
  assert.throws(() => assertFrame("controls", frame({ controls: { "Done column display": false } }), clip), /Done column display visible/);
});

test("identity check allows only the synthetic account and demo repository", () => {
  const expected = { account: "orbitron-demo", repository: REPOSITORY };
  assertSyntheticIdentity(page(), expected);
  assert.throws(() => assertSyntheticIdentity(page({ account: "Signed in as someone-real · 3 repositories" }), expected), /synthetic account/);
  assert.throws(() => assertSyntheticIdentity(page({ repositoryOptions: [REPOSITORY, "Owner/private-repo"] }), expected), /only the demo repository/);
  assert.throws(() => assertSyntheticIdentity(page({ cardKeys: ["Owner/private-repo#1"] }), expected), /demo repository/);
  assert.throws(() => assertSyntheticIdentity(page({ text: ["client", "example.org"].join("@") }), expected), /email/);
});

test("session check requires a temporary profile and a port other than the personal Canvas", () => {
  const profile = path.join(os.tmpdir(), "canvas-demo-profile-abc123");
  assertIsolatedSession(profile, 53111);
  assert.throws(() => assertIsolatedSession(profile, 4173), /personal Canvas port/);
  assert.throws(() => assertIsolatedSession(path.join(os.homedir(), "chrome-profile"), 53111), /temporary directory|fresh capture profile/);
});
