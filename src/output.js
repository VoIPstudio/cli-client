// Results go to stdout, everything else to stderr, so `vs ... > file.json`
// yields a clean document while progress stays visible on the terminal.
export function emit(value, { format = "json", columns = null, out = process.stdout } = {}) {
    if (format === "table") {
        out.write(renderTable(value, columns));
        return;
    }
    out.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function status(message, err = process.stderr) {
    err.write(`${message}\n`);
}

function cell(value) {
    if (value === null || value === undefined) {
        return "";
    }
    return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export function renderTable(value, columns = null) {
    const rows = Array.isArray(value) ? value : [value];
    if (rows.length === 0) {
        return "No results.\n";
    }
    const keys = columns ?? [...new Set(rows.flatMap((row) => Object.keys(row)))];
    const widths = keys.map((key) => Math.max(key.length, ...rows.map((row) => cell(row[key]).length)));
    const line = (cells) => `${cells.map((text, i) => text.padEnd(widths[i])).join("  ").trimEnd()}\n`;
    return [
        line(keys),
        line(widths.map((width) => "-".repeat(width))),
        ...rows.map((row) => line(keys.map((key) => cell(row[key])))),
    ].join("");
}
