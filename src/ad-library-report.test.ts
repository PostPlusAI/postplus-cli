import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeAdReport, renderAdReport } from "./ad-library-report.js";
import { runAdLibraryCommand } from "./ad-library.js";
const ad = (id = "123") => ({
  ad_archive_id: id,
  page_id: "99",
  page_name: "Example",
  is_active: true,
  publisher_platform: ["FACEBOOK", "INSTAGRAM"],
  start_date: 1750000000,
  snapshot: {
    page_profile_picture_url: "https://example.test/logo.png",
    body: { text: "Actual text" },
    videos: [{ video_hd_url: "https://example.test/video.mp4" }],
    title: "Headline",
    cta_text: "Learn more",
    link_url: "https://example.test/landing",
  },
});
const input = (items: unknown[]) => ({
  name: "fresh.json",
  payload: {
    routeKey: "facebook-ads-library",
    status: "completed",
    output: { fetchedAt: "2026-10-12T01:00:00Z", items },
  },
});
test("retains more than 150 ads and all creative variants, deduplicates archive IDs", () => {
  const ads = Array.from({ length: 180 }, (_, i) => ad(String(i)));
  const variant = ad("0");
  variant.snapshot.body.text = "Second variant";
  const result = normalizeAdReport([input(ads), input([ads[0], variant])]);
  assert.equal(result.ads.length, 180);
  assert.equal(result.ads[0]!.creatives.length, 2);
  const html = renderAdReport([input(ads)]);
  assert.equal((html.match(/class="card"/g) || []).length, 180);
  assert.match(html, /preload="none"/);
  assert.match(html, /Checked:/);
  assert.match(html, /Platforms: FACEBOOK, INSTAGRAM/);
});
test("stored results normalize with correct observation, relative public logos and pagination disclosure", () => {
  const result = {
    name: "stored.json",
    payload: {
      schemaVersion: 1,
      nextOffset: 50,
      items: [
        {
          archive_id: "123",
          page_id: "99",
          status: "inactive",
          observed_at: "2026-10-01",
          brands: [
            {
              name: "Example",
              logo_url: "/images/ad-library/brands/example.webp",
            },
          ],
          media: [{ kind: "video", url: "https://example.test/v.mp4" }],
          body: "Stored body",
        },
      ],
    },
  };
  const data = normalizeAdReport([result]);
  assert.equal(data.ads[0]!.status, "inactive");
  assert.match(data.ads[0]!.logo, /^https:\/\/postplus.io/);
  assert.match(renderAdReport([result]), /only one page/);
});
test("failed and pending outcomes are explicit, unknown payloads and missing items reject", () => {
  for (const status of ["failed", "running", "pending"]) {
    const html = renderAdReport([
      {
        name: "operation.json",
        payload: {
          routeKey: "facebook-ads-library",
          status,
          error: { message: "Provider rejected request" },
        },
      },
    ]);
    assert.match(html, new RegExp(status));
    assert.match(html, /Provider rejected request/);
  }
  assert.throws(
    () => normalizeAdReport([{ name: "x", payload: {} }]),
    /Unsupported/,
  );
  assert.throws(
    () =>
      normalizeAdReport([
        {
          name: "x",
          payload: { routeKey: "facebook-ads-library", status: "completed" },
        },
      ]),
    /Missing ad items/,
  );
});
test("escapes source content and rejects executable or credentialed URLs", () => {
  const a = ad();
  a.snapshot.body.text = '</script><script>alert("x")</script>';
  a.page_name = '" onmouseover="alert(1)';
  const html = renderAdReport([input([a])]);
  assert.ok(!html.includes("<script>alert"));
  assert.match(html, /&lt;\/script&gt;/);
  assert.equal((html.match(/<script>/g) || []).length, 1);
  for (const unsafe of [
    "javascript:alert(1)",
    "data:text/html,hi",
    "file:///tmp/x",
    "https://user:pass@example.test",
  ]) {
    const a = ad();
    a.snapshot.link_url = unsafe;
    assert.throws(() => renderAdReport([input([a])]));
  }
});
test("offline command accepts repeated inputs, preserves source files and publishes HTML atomically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ad-report-"));
  try {
    const source = join(dir, "input.json"),
      out = join(dir, "report.html");
    const json = JSON.stringify(input([ad()]).payload);
    await writeFile(source, json);
    await runAdLibraryCommand(
      ["report", "--input", source, "--input", source, "--output", out],
      {
        output: () => {},
        request: async () => assert.fail("report must not request network"),
      },
    );
    assert.match(await readFile(out, "utf8"), /1 unique ads/);
    assert.equal(await readFile(source, "utf8"), json);
    await assert.rejects(
      runAdLibraryCommand(["report", "--input", source, "--output", source]),
      /overwrite/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
