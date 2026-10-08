import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearProfile, configPath, readConfig, resolveCredentials, saveProfile, writeConfig } from "../src/config.js";

function tempConfig() {
    return join(mkdtempSync(join(tmpdir(), "vs-test-")), "config.json");
}

test("configPath honours XDG_CONFIG_HOME", () => {
    assert.equal(configPath({ XDG_CONFIG_HOME: "/x" }), "/x/voipstudio/config.json");
    assert.equal(configPath({ HOME: "/home/u" }), "/home/u/.config/voipstudio/config.json");
});

test("a missing config reads as empty rather than throwing", () => {
    const config = readConfig(join(tmpdir(), "vs-does-not-exist", "config.json"));
    assert.deepEqual(config.profiles, {});
    assert.equal(config.current, "default");
});

test("the config file is written 0600 so tokens are not world-readable", () => {
    const path = tempConfig();
    saveProfile("default", { token: "secret" }, path);
    assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("an existing loose-permission file is tightened on write", () => {
    const path = tempConfig();
    writeConfig({ version: 1, current: "default", profiles: {} }, path);
    writeFileSync(path, "{}", { mode: 0o644 });
    saveProfile("default", { token: "secret" }, path);
    assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("saveProfile merges into an existing profile and makes it current", () => {
    const path = tempConfig();
    saveProfile("work", { token: "t1", email: "a@b.c" }, path);
    saveProfile("work", { token: "t2" }, path);
    const config = readConfig(path);
    assert.equal(config.current, "work");
    assert.deepEqual(config.profiles.work, { token: "t2", email: "a@b.c" });
});

test("VOIPSTUDIO_API_TOKEN wins over any stored profile", () => {
    const path = tempConfig();
    saveProfile("default", { token: "stored" }, path);
    const creds = resolveCredentials({ env: { VOIPSTUDIO_API_TOKEN: "from-env" }, path });
    assert.equal(creds.token, "from-env");
    assert.equal(creds.source, "VOIPSTUDIO_API_TOKEN");
});

test("resolveCredentials reports no token when the profile is absent", () => {
    const creds = resolveCredentials({ profile: "nope", env: {}, path: tempConfig() });
    assert.equal(creds.token, null);
    assert.equal(creds.profile, "nope");
});

test("clearing the last profile removes the file entirely", () => {
    const path = tempConfig();
    saveProfile("default", { token: "t" }, path);
    clearProfile("default", path);
    assert.equal(existsSync(path), false);
});

test("clearing one of several profiles keeps the rest and moves `current`", () => {
    const path = tempConfig();
    saveProfile("a", { token: "ta" }, path);
    saveProfile("b", { token: "tb" }, path);
    clearProfile("b", path);
    const config = readConfig(path);
    assert.deepEqual(Object.keys(config.profiles), ["a"]);
    assert.equal(config.current, "a");
});

test("a corrupt config file fails with an actionable message", () => {
    const path = tempConfig();
    writeFileSync(path, "{not json");
    assert.throws(() => readConfig(path), /not valid JSON/);
});
