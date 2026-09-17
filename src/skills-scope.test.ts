import { serializeInstallerEntries } from './fixtures/skills-bundle-fixture.test.js';
import {
  INSTALLER_LABELS,
  writeFixtureBundle,
  writeInstalledFixture,
} from "./fixtures/skills-bundle-fixture.test.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock, type TestContext } from "node:test";
import { buildPostPlusClientCompatibilityHeaders } from "./client-compatibility.js";
import {
  readManagedSkillBaseline,
  writeManagedSkillBaseline,
  writeLocalConfig,
} from "./local-state.js";
import {
  generateSkillInstallStatusReport,
  runPostPlusSkillUpdate,
  runPostPlusSkillVerify,
} from "./skill-management.js";
import { resolvePostPlusSkillsScope } from "./skill-installation.js";

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "postplus-scope-")));
  const home = join(root, "home");
  const project = join(root, "project");
  const other = join(root, "other");
  const config = join(root, "config");
  await Promise.all([home, project, other, config].map((path) => mkdir(path)));
  const environment = { ...process.env };
  const cwd = process.cwd();
  const fetchFn = globalThis.fetch;
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    POSTPLUS_CONFIG_DIR: config,
    XDG_STATE_HOME: join(root, "state"),
  });
  process.chdir(project);
  process.env.POSTPLUS_SKILLS_SOURCE = join(root, "bundle");
  delete process.env.POSTPLUS_SKILLS_CATALOG_URL;
  await writeFixtureBundle(process.env.POSTPLUS_SKILLS_SOURCE, {
    schemaVersion: 2,
    releaseId: "skills-2026-09-02.1",
    source: "PostPlusAI/postplus-skills",
    productBrief: {
      schemaVersion: 1,
      paragraphs: ["FIRST-INSTALL-BRIEF"],
    },
    releaseNotes: {
      schemaVersion: 1,
      releaseId: "skills-2026-09-02.1",
      title: "Official release notes",
      summary: "Released maintenance improvements.",
      highlights: ["Current project updates preserve their scope."],
    },
    skills: [
      { name: "demo", path: "skills/demo/SKILL.md", status: "released" },
    ],
  });
  t.after(async () => {
    mock.restoreAll();
    syncBuiltinESMExports();
    process.chdir(cwd);
    for (const key of Object.keys(process.env))
      if (!(key in environment)) delete process.env[key];
    Object.assign(process.env, environment);
    globalThis.fetch = fetchFn;
    await rm(root, { recursive: true, force: true });
  });
  const installed = new Set<string>();
  const mutations: string[] = [];
  const linkedTargets = new Set<string>();
  const lock = async (target: string) => {
    const path =
      target === home
        ? join(root, "state", "skills", ".skill-lock.json")
        : join(target, "skills-lock.json");
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        version: 3,
        skills: { demo: { source: "PostPlusAI/postplus-skills" } },
      }),
    );
    await writeInstalledFixture(join(target, "demo"));
    installed.add(target);
  };
  const dependencies = {
    runCommand: async (_command: string, args: string[]) => {
      const target = args.includes("--global") ? home : process.cwd();
      return {
        stderr: "",
        stdout: serializeInstallerEntries(
          installed.has(target)
            ? [
                {
                  name: "demo",
                  scope: target === home ? "global" : "project",
                  path: join(target, "demo"),
                  agents: linkedTargets.has(target)
                    ? INSTALLER_LABELS
                    : ["Codex"],
                },
              ]
            : [],
        ),
      };
    },
    runInteractiveCommand: async (_command: string, args: string[]) => {
      const target = args.includes("--global") ? home : process.cwd();
      mutations.push(target);
      await lock(target);
      linkedTargets.add(target);
      return 0;
    },
  };
  return {
    root,
    home,
    project,
    other,
    config,
    installed,
    linkedTargets,
    mutations,
    lock,
    dependencies,
  };
}

test("an account baseline cannot prove the release of an unverified project", async (t) => {
  const f = await fixture(t);
  await writeLocalConfig({
    managedSkills: { releaseId: "skills-2026-09-02.1", skillNames: ["demo"] },
  });
  await f.lock(f.project);
  assert.equal((await readManagedSkillBaseline()).releaseId, null);
  const headers = await buildPostPlusClientCompatibilityHeaders();
  assert.equal(headers["x-postplus-skills-release-id"], undefined);
});

test("global upgrade cannot lend its release to old project skills or verify them by name", async (t) => {
  const f = await fixture(t);
  await f.lock(f.project);
  await runPostPlusSkillUpdate(f.dependencies, { scope: "global" });
  assert.equal((await readManagedSkillBaseline()).releaseId, null);
  const report = await runPostPlusSkillVerify(f.dependencies);
  assert.equal(report.ok, false);
  assert.equal(report.baselineUpdated, false);
  assert.equal((await readManagedSkillBaseline()).releaseId, null);
  assert.equal(
    (await buildPostPlusClientCompatibilityHeaders())[
      "x-postplus-skills-release-id"
    ],
    undefined,
  );
});

test("status cannot advance a release from equal skill names", async (t) => {
  const f = await fixture(t);
  await f.lock(f.project);
  const report = await generateSkillInstallStatusReport(f.dependencies);
  assert.equal(report.ok, false);
  assert.equal(report.managedSkillsReleaseId, null);
  assert.equal((await readManagedSkillBaseline()).releaseId, null);
});

test("default update preserves project scope and switching verified projects does not reinstall", async (t) => {
  const f = await fixture(t);
  await f.lock(f.project);
  await runPostPlusSkillUpdate(f.dependencies);
  assert.ok(f.mutations.every((target) => target === f.project));
  const first = await readFile(
    join(f.project, ".postplus-skills.json"),
    "utf8",
  );
  assert.equal(JSON.parse(first).releaseId, "skills-2026-09-02.1");
  await f.lock(f.other);
  process.chdir(f.other);
  assert.equal((await readManagedSkillBaseline()).releaseId, null);
  await runPostPlusSkillUpdate(f.dependencies);
  f.mutations.length = 0;
  process.chdir(f.project);
  await runPostPlusSkillUpdate(f.dependencies);
  assert.deepEqual(f.mutations, []);
  assert.equal(
    await readFile(join(f.project, ".postplus-skills.json"), "utf8"),
    first,
  );
  assert.equal(
    (await buildPostPlusClientCompatibilityHeaders())[
      "x-postplus-skills-release-id"
    ],
    "skills-2026-09-02.1",
  );
  t.diagnostic(
    "A → B → A: final installer calls=0; project A baseline bytes unchanged",
  );
});

test("no project installation selects global, including an empty setup", async (t) => {
  const f = await fixture(t);
  await runPostPlusSkillUpdate(f.dependencies);
  assert.ok(
    f.mutations.length > 0 && f.mutations.every((target) => target === f.home),
  );
  assert.equal(
    (await readManagedSkillBaseline()).releaseId,
    "skills-2026-09-02.1",
  );
  f.mutations.length = 0;
  process.chdir(f.other);
  await runPostPlusSkillUpdate(f.dependencies);
  assert.deepEqual(f.mutations, []);
});

test("coexisting project/global installs update only the current project", async (t) => {
  const f = await fixture(t);
  await f.lock(f.project);
  await f.lock(f.home);
  await runPostPlusSkillUpdate(f.dependencies);
  assert.ok(
    f.mutations.length > 0 &&
      f.mutations.every((target) => target === f.project),
  );
  await assert.rejects(readFile(join(f.home, ".postplus-skills.json")), {
    code: "ENOENT",
  });
});

test("an existing installation without a baseline summarizes once, then verifies without session restart", async (t) => {
  const f = await fixture(t);
  await f.lock(f.project);
  const messages: string[] = [];
  const dependencies = {
    ...f.dependencies,
    reportSuccess: (message: string) => messages.push(message),
  };
  await runPostPlusSkillUpdate(dependencies);
  assert.match(messages.join("\n"), /PostPlus Skills updated/);
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /ready on disk.*Start a new agent session/);
  assert.doesNotMatch(
    messages.join("\n"),
    /FIRST-INSTALL-BRIEF|Official release notes|PostPlus is ready/,
  );
  f.mutations.length = 0;
  messages.length = 0;
  await runPostPlusSkillUpdate(dependencies);
  assert.deepEqual(f.mutations, []);
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /already current/);
  assert.doesNotMatch(messages[0]!, /new agent session|restart/i);
  assert.doesNotMatch(
    messages[0]!,
    /FIRST-INSTALL-BRIEF|Official release notes/,
  );
});

test("malformed project installer state stops before selecting global or mutating", async (t) => {
  const f = await fixture(t);
  for (const contents of ["{broken", "{}", '{"version":3,"skills":[]}']) {
    await writeFile(join(f.project, "skills-lock.json"), contents);
    await assert.rejects(runPostPlusSkillUpdate(f.dependencies), {
      code: "postplus_skills_scope_failed",
    });
  }
  assert.deepEqual(f.mutations, []);
});

test("a deleted working directory fails scope resolution", async (t) => {
  const f = await fixture(t);
  await rm(f.project, { recursive: true });
  await assert.rejects(resolvePostPlusSkillsScope(), {
    code: "postplus_skills_scope_failed",
  });
});

test("malformed baseline fails instead of borrowing another scope", async (t) => {
  const f = await fixture(t);
  await f.lock(f.project);
  for (const contents of [
    "{broken",
    JSON.stringify({ releaseId: "skills-2026-09-02.1", skillNames: [12] }),
  ]) {
    await writeFile(join(f.project, ".postplus-skills.json"), contents);
    await assert.rejects(readManagedSkillBaseline(), {
      code: "postplus_skills_baseline_read_failed",
    });
    await assert.rejects(runPostPlusSkillUpdate(f.dependencies), {
      code: "postplus_skills_baseline_read_failed",
    });
  }
  assert.deepEqual(f.mutations, []);
});

test("moving a verified project preserves its release without reinstalling", async (t) => {
  const f = await fixture(t);
  await f.lock(f.project);
  await runPostPlusSkillUpdate(f.dependencies);
  const moved = join(f.root, "moved-project");
  await fs.promises.rename(f.project, moved);
  process.chdir(moved);
  f.installed.add(moved);
  f.linkedTargets.add(moved);
  f.mutations.length = 0;
  assert.equal(
    (await readManagedSkillBaseline()).releaseId,
    "skills-2026-09-02.1",
  );
  await runPostPlusSkillUpdate(f.dependencies);
  assert.deepEqual(f.mutations, []);
});

test("baseline persistence is probed before the installer and does not overwrite prior bytes", async (t) => {
  const f = await fixture(t);
  await f.lock(f.project);
  await writeManagedSkillBaseline({
    releaseId: "skills-2026-09-01.1",
    skillNames: ["demo"],
  });
  const target = join(f.project, ".postplus-skills.json");
  const before = await readFile(target, "utf8");
  const originalOpen = fs.promises.open;
  mock.method(
    fs.promises,
    "open",
    async (...args: Parameters<typeof originalOpen>) => {
      if (String(args[0]).includes(".postplus-skills-"))
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      return originalOpen(...args);
    },
  );
  syncBuiltinESMExports();
  await assert.rejects(runPostPlusSkillUpdate(f.dependencies), {
    code: "postplus_skills_baseline_write_failed",
  });
  assert.deepEqual(f.mutations, []);
  assert.equal(await readFile(target, "utf8"), before);
});

test("atomic baseline commit failure preserves the previous release and removes temporary files", async (t) => {
  const f = await fixture(t);
  await f.lock(f.project);
  await writeManagedSkillBaseline({
    releaseId: "skills-2026-09-01.1",
    skillNames: ["demo"],
  });
  const target = join(f.project, ".postplus-skills.json");
  const before = await readFile(target, "utf8");
  const originalRename = fs.promises.rename;
  mock.method(
    fs.promises,
    "rename",
    async (...args: Parameters<typeof originalRename>) => {
      if (String(args[1]) === target)
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      return originalRename(...args);
    },
  );
  syncBuiltinESMExports();
  await assert.rejects(runPostPlusSkillUpdate(f.dependencies), {
    code: "postplus_skills_baseline_write_failed",
  });
  assert.ok(f.mutations.length > 0);
  assert.equal(await readFile(target, "utf8"), before);
  assert.deepEqual((await fs.promises.readdir(f.project)).sort(), [
    ".postplus-skills.json",
    "demo",
    "skills-lock.json",
  ]);
});
