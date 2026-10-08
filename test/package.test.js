import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { openSync, readFileSync, readSync, closeSync, statSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const binEntries = Object.entries(typeof pkg.bin === "string" ? { [pkg.name]: pkg.bin } : pkg.bin ?? {});

test("package.json declares at least one bin entry", () => {
    assert.ok(binEntries.length > 0, "no bin entry to check");
});

// npm chmods bin targets to 755 when it installs them. If git has the file
// recorded 100644, that chmod shows up as a permanent unstaged diff and every
// contributor's tree looks dirty after `npm install`.
test("every bin target is recorded executable in git", () => {
    const listing = execFileSync("git", ["ls-files", "-s", ...binEntries.map(([, rel]) => rel)], {
        cwd: new URL("..", import.meta.url).pathname,
        encoding: "utf8",
    });
    assert.ok(listing.trim(), "git did not report the bin files");
    for (const line of listing.trim().split("\n")) {
        const mode = line.split(/\s+/)[0];
        assert.equal(mode, "100755", `expected 100755 for "${line}", got ${mode}`);
    }
});

test("every bin target starts with a shebang, so the executable bit means something", () => {
    for (const [, rel] of binEntries) {
        const fd = openSync(new URL(`../${rel}`, import.meta.url), "r");
        const buf = Buffer.alloc(2);
        readSync(fd, buf, 0, 2, 0);
        closeSync(fd);
        assert.equal(buf.toString(), "#!", `${rel} has no shebang`);
    }
});

test("every path listed for packing exists", () => {
    // "files" mixes directories and files, so stat - not readFileSync, which
    // throws EISDIR on a directory.
    for (const entry of pkg.files ?? []) {
        const target = new URL(`../${entry}`, import.meta.url);
        assert.doesNotThrow(() => statSync(target), `${entry} is listed in "files" but missing`);
    }
});

test("package-lock.json records the same version as package.json", () => {
    // npm rewrites the lockfile's version fields on install. If a release bump
    // misses them, every `npm install` leaves the tree dirty - the same symptom
    // the executable-bit fix addressed, from a different cause.
    const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
    assert.equal(lock.version, pkg.version, "package-lock.json top-level version drifted");
    assert.equal(lock.packages?.[""]?.version, pkg.version, 'package-lock.json packages[""] version drifted');
});
