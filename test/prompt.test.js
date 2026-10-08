import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { promptHidden, requireTty } from "../src/prompt.js";

// A stand-in TTY: PassThrough plus the isTTY/setRawMode surface promptHidden
// needs, recording raw-mode transitions so they can be asserted on.
function fakeTty() {
    const input = new PassThrough();
    input.isTTY = true;
    input.isRaw = false;
    input.rawModeCalls = [];
    input.setRawMode = (on) => {
        input.isRaw = on;
        input.rawModeCalls.push(on);
        return input;
    };
    const output = new PassThrough();
    output.written = "";
    output.on("data", (c) => {
        output.written += c.toString();
    });
    return { input, output };
}

test("the prompt is written and never erased", async () => {
    // The bug this replaces: readline's line refresh emitted cursor-move and
    // clear-screen escapes straight to the output, wiping the prompt and
    // leaving the user staring at a blank line.
    const { input, output } = fakeTty();
    const pending = promptHidden("Password: ", { input, output });
    input.write("pw\n");
    await pending;
    assert.ok(output.written.startsWith("Password: "), output.written);
    assert.ok(!/\[\d*[GJK]/.test(output.written), `escape sequences found: ${JSON.stringify(output.written)}`);
});

test("typed characters are not echoed", async () => {
    const { input, output } = fakeTty();
    const pending = promptHidden("Password: ", { input, output });
    input.write("hunter2\n");
    await pending;
    assert.ok(!output.written.includes("hunter2"), output.written);
});

test("the typed value is returned intact", async () => {
    const { input, output } = fakeTty();
    const pending = promptHidden("p: ", { input, output });
    input.write("s3cr3t!\n");
    assert.equal(await pending, "s3cr3t!");
});

test("a value split across chunks is reassembled", async () => {
    const { input, output } = fakeTty();
    const pending = promptHidden("p: ", { input, output });
    input.write("abc");
    input.write("def");
    input.write("\n");
    assert.equal(await pending, "abcdef");
});

test("carriage return ends input as well as newline", async () => {
    const { input, output } = fakeTty();
    const pending = promptHidden("p: ", { input, output });
    input.write("xyz\r");
    assert.equal(await pending, "xyz");
});

test("backspace deletes the previous character", async () => {
    const { input, output } = fakeTty();
    const pending = promptHidden("p: ", { input, output });
    input.write("abcZ\n");
    assert.equal(await pending, "aZ");
});

test("backspace on an empty value does not underflow", async () => {
    const { input, output } = fakeTty();
    const pending = promptHidden("p: ", { input, output });
    input.write("ok\n");
    assert.equal(await pending, "ok");
});

test("arrow keys and other escapes never reach the value", async () => {
    const { input, output } = fakeTty();
    const pending = promptHidden("p: ", { input, output });
    input.write("a[Db\n");
    assert.equal(await pending, "ab");
});

test("raw mode is enabled and then restored to its prior state", async () => {
    const { input, output } = fakeTty();
    const pending = promptHidden("p: ", { input, output });
    input.write("x\n");
    await pending;
    assert.deepEqual(input.rawModeCalls, [true, false]);
    assert.equal(input.isRaw, false);
});

test("the data listener is removed, so a later prompt gets the input", async () => {
    const { input, output } = fakeTty();
    const pending = promptHidden("p: ", { input, output });
    input.write("one\n");
    await pending;
    assert.equal(input.listenerCount("data"), 0);
});

test("a newline is written after input so the next output starts on its own line", async () => {
    const { input, output } = fakeTty();
    const pending = promptHidden("p: ", { input, output });
    input.write("q\n");
    await pending;
    assert.ok(output.written.endsWith("\n"), JSON.stringify(output.written));
});

test("a non-TTY input is refused rather than silently echoing the password", () => {
    const input = new PassThrough();
    input.isTTY = false;
    assert.throws(() => promptHidden("p: ", { input, output: new PassThrough() }),
                  /needs an interactive terminal/);
});

test("requireTty rejects a non-interactive stdin with an actionable message", () => {
    assert.throws(() => requireTty({ isTTY: false }), /VOIPSTUDIO_API_TOKEN/);
    assert.doesNotThrow(() => requireTty({ isTTY: true }));
});
