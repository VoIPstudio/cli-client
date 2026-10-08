import { createInterface } from "node:readline";

// Prompts are written to stderr, keeping stdout clean for the JSON result so
// `vs auth login > me.json` still works while the user is being asked for input.
export async function prompt(question, { hidden = false, input = process.stdin, output = process.stderr } = {}) {
    const rl = createInterface({ input, output, terminal: true });
    if (hidden) {
        // readline has no masking option; suppressing its echo is the documented
        // workaround. The prompt itself is written once, by hand, before muting.
        output.write(question);
        rl._writeToOutput = () => {};
    }
    try {
        const answer = await new Promise((resolve) => rl.question(hidden ? "" : question, resolve));
        return answer.trim();
    } finally {
        rl.close();
        if (hidden) {
            output.write("\n");
        }
    }
}

export function requireTty(stream = process.stdin) {
    if (!stream.isTTY) {
        throw new Error(
            "vs auth login needs an interactive terminal. In a non-interactive environment, set VOIPSTUDIO_API_TOKEN instead.",
        );
    }
}
