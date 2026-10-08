import { createInterface } from "node:readline";

// Prompts are written to stderr, keeping stdout clean for the JSON result so
// `vs auth login > me.json` still works while the user is being asked for input.
export function prompt(question, { input = process.stdin, output = process.stderr } = {}) {
    const rl = createInterface({ input, output, terminal: true });
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

const ENTER = new Set(["\r", "\n"]);
const BACKSPACE = new Set(["\u007f", "\b"]);
const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
const ESC = "\u001b";

// Hidden input is read from raw mode by hand rather than through readline.
// readline with terminal:true redraws the line when the question starts, and
// that redraw writes cursor-move and clear-screen escapes straight to the
// output stream - bypassing any _writeToOutput override used to suppress
// echo, and erasing the prompt. The result on a real terminal is a blank line
// and no visible prompt at all.
export function promptHidden(question, { input = process.stdin, output = process.stderr } = {}) {
    if (!input.isTTY) {
        throw new Error("a hidden prompt needs an interactive terminal");
    }
    return new Promise((resolve) => {
        output.write(question);
        const wasRaw = Boolean(input.isRaw);
        input.setRawMode(true);
        input.resume();

        let value = "";
        let escapeState = null;
        const finish = (result, code) => {
            input.removeListener("data", onData);
            input.setRawMode(wasRaw);
            input.pause();
            output.write("\n");
            if (code !== undefined) {
                process.exit(code);
            }
            resolve(result);
        };

        const onData = (chunk) => {
            for (const ch of chunk.toString("utf8")) {
                // An arrow key arrives as ESC [ D, so dropping only the ESC
                // would leave "[D" in the password. ESC opens a two-state skip:
                // "[" moves into CSI, where bytes are discarded up to and
                // including the final byte (0x40-0x7E). Note "[" is itself in
                // that range, so it must be consumed as an introducer first or
                // the sequence ends immediately and "D" leaks through.
                if (escapeState === "esc") {
                    escapeState = ch === "[" ? "csi" : null;
                    continue;
                }
                if (escapeState === "csi") {
                    if (ch >= "@" && ch <= "~") {
                        escapeState = null;
                    }
                    continue;
                }
                if (ch === ESC) {
                    escapeState = "esc";
                    continue;
                }
                if (ENTER.has(ch)) {
                    finish(value);
                    return;
                }
                if (ch === CTRL_C) {
                    finish("", 130);
                    return;
                }
                if (ch === CTRL_D && value === "") {
                    finish("", 130);
                    return;
                }
                if (BACKSPACE.has(ch)) {
                    value = value.slice(0, -1);
                    continue;
                }
                // Printable characters only; other control bytes are dropped.
                if (ch >= " " && ch !== "\u007f") {
                    value += ch;
                }
            }
        };

        input.on("data", onData);
    });
}

export function requireTty(stream = process.stdin) {
    if (!stream.isTTY) {
        throw new Error(
            "vs auth login needs an interactive terminal. In a non-interactive environment, set VOIPSTUDIO_API_TOKEN instead.",
        );
    }
}
