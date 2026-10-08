import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { chmodSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";

const CONFIG_VERSION = 1;
export const DEFAULT_PROFILE = "default";

// Credentials live in the XDG config dir rather than beside the install, so a
// global npm update never discards them.
export function configPath(env = process.env) {
    const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
    return join(base, "voipstudio", "config.json");
}

function emptyConfig() {
    return { version: CONFIG_VERSION, current: DEFAULT_PROFILE, profiles: {} };
}

export function readConfig(path = configPath()) {
    let raw;
    try {
        raw = readFileSync(path, "utf8");
    } catch (err) {
        if (err.code === "ENOENT") {
            return emptyConfig();
        }
        throw err;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error(`Config file at ${path} is not valid JSON — fix or delete it, then run "vs auth login".`);
    }
    return { ...emptyConfig(), ...parsed, profiles: parsed.profiles ?? {} };
}

// The file holds API tokens, so it is written 0600 inside a 0700 directory.
// chmod is applied after the write as well, because an existing file keeps its
// old mode and writeFileSync's `mode` option is ignored for it.
export function writeConfig(config, path = configPath()) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
}

export function getProfile(config, name) {
    return config.profiles[name ?? config.current ?? DEFAULT_PROFILE] ?? null;
}

export function saveProfile(name, profile, path = configPath()) {
    const config = readConfig(path);
    const key = name ?? config.current ?? DEFAULT_PROFILE;
    config.profiles[key] = { ...config.profiles[key], ...profile };
    config.current = key;
    writeConfig(config, path);
    return config.profiles[key];
}

export function clearProfile(name, path = configPath()) {
    const config = readConfig(path);
    const key = name ?? config.current ?? DEFAULT_PROFILE;
    delete config.profiles[key];
    if (Object.keys(config.profiles).length === 0) {
        try {
            unlinkSync(path);
        } catch (err) {
            if (err.code !== "ENOENT") {
                throw err;
            }
        }
        return;
    }
    if (config.current === key) {
        config.current = Object.keys(config.profiles)[0];
    }
    writeConfig(config, path);
}

// Precedence mirrors the `cf` CLI: an explicit env var always wins, so CI can
// authenticate without ever writing a config file.
export function resolveCredentials({ profile, env = process.env, path = configPath() } = {}) {
    if (env.VOIPSTUDIO_API_TOKEN) {
        return { token: env.VOIPSTUDIO_API_TOKEN, source: "VOIPSTUDIO_API_TOKEN", profile: null };
    }
    const config = readConfig(path);
    const name = profile ?? config.current ?? DEFAULT_PROFILE;
    const stored = config.profiles[name];
    if (!stored?.token) {
        return { token: null, source: null, profile: name };
    }
    return { token: stored.token, source: path, profile: name, apiUrl: stored.apiUrl, email: stored.email };
}
