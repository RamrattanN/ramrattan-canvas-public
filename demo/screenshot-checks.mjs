// Pure checks used by demo/capture.mjs before and after each documentation screenshot.
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

export const PAGE_TITLE = "Orbitron Sprocket Works | Project Delivery Board";
export const PERSONAL_CANVAS_PORT = 4173;

// Reads width and height from a PNG IHDR chunk.
export function pngSize(buffer) {
  assert.ok(buffer.length >= 24 && buffer.toString("ascii", 1, 4) === "PNG", "not a PNG image");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

// Every screenshot starts at the top-left corner and spans the viewport, so the application header is never cropped.
export function assertFullWidthClip(name, clip, viewportWidth, documentHeight) {
  assert.equal(clip.x, 0, `${name}: clip starts at the left edge`);
  assert.equal(clip.y, 0, `${name}: clip starts at the top of the page`);
  assert.equal(clip.width, viewportWidth, `${name}: clip spans the viewport width`);
  assert.ok(clip.height > 0 && clip.height <= Math.ceil(documentHeight), `${name}: clip height stays inside the page`);
}

// The image must match the clip at the device scale; Chrome may round a fractional edge by one pixel.
export function assertImageSize(name, size, clip, scale) {
  for (const side of ["width", "height"]) assert.ok(Math.abs(size[side] - clip[side] * scale) <= 1, `${name}: image ${side} ${size[side]} matches the capture boundary`);
}

// The header, brand logo, project logo, and project title must be rendered and inside the clip.
export function assertFrame(name, frame, clip) {
  const inside = (rect) => rect && rect.width > 0 && rect.height > 0 && rect.x >= clip.x && rect.y >= clip.y && rect.x + rect.width <= clip.x + clip.width + 0.5 && rect.y + rect.height <= clip.y + clip.height + 0.5;
  assert.ok(inside(frame.header), `${name}: application header inside the image`);
  assert.equal(Math.round(frame.header.width), clip.width, `${name}: application header at full width`);
  assert.ok(frame.brandLogoLoaded && inside(frame.brandLogo), `${name}: Ramrattan shield rendered`);
  assert.ok(frame.projectLogoLoaded && inside(frame.projectLogo), `${name}: Orbitron logo rendered`);
  assert.ok(inside(frame.title), `${name}: project title inside the image`);
  assert.equal(frame.titleText, PAGE_TITLE, `${name}: project title`);
  for (const [control, present] of Object.entries(frame.controls)) assert.ok(present, `${name}: ${control} visible`);
}

// Only the synthetic account, the demo repository, and its records may appear on the page.
export function assertSyntheticIdentity(page, { account, repository }) {
  assert.equal(page.account, `Signed in as ${account} · 1 repository`, "synthetic account label");
  assert.deepEqual(page.repositoryOptions, [repository], "repository list holds only the demo repository");
  assert.ok(page.cardKeys.length > 0 && page.cardKeys.every((key) => key.startsWith(`${repository}#`)), "every card comes from the demo repository");
  assert.ok(page.links.every((href) => href.startsWith(`https://github.com/${repository}/`)), "every record link points at the demo repository");
  assert.ok(!/[\w.+-]+@[\w-]+\.[\w.]+/.test(page.text), "no email address on the page");
}

// The browser profile is disposable and the server is never the personal Canvas origin, whose saved boards live in localStorage.
export function assertIsolatedSession(profile, port) {
  assert.ok(path.resolve(profile).startsWith(path.resolve(os.tmpdir())), "browser profile is inside the temporary directory");
  assert.match(path.basename(profile), /^canvas-demo-profile-/, "browser profile is a fresh capture profile");
  assert.notEqual(port, PERSONAL_CANVAS_PORT, "capture server is not the personal Canvas port");
}
