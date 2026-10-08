import { ApiError } from "./api.js";

export const RESOURCE = "monitors";

// Columns chosen for `--format table`; the full record has ~24 fields, which is
// unreadable as a table and is what `--format json` is for.
export const TABLE_COLUMNS = ["id", "timestamp", "caller", "called", "duration", "type"];

// Verified against the live API 2026-10-08: eq, like, gt, gte, lt and lte all
// work and multiple entries AND together. `between` is NOT supported - it
// answers 400 - so a date range is expressed as a gte plus an lte.
const OPERATORS = new Set(["eq", "like", "gt", "gte", "lt", "lte"]);

function parseRawFilter(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new ApiError(`--filter is not valid JSON: ${raw}`);
    }
    if (!Array.isArray(parsed)) {
        throw new ApiError('--filter must be a JSON array, e.g. \'[{"property":"duration","operator":"gt","value":60}]\'');
    }
    for (const entry of parsed) {
        if (!entry || !entry.property || !entry.operator) {
            throw new ApiError("each --filter entry needs a property and an operator");
        }
        if (!OPERATORS.has(entry.operator)) {
            throw new ApiError(
                `unsupported filter operator "${entry.operator}" - the API accepts: ${[...OPERATORS].join(", ")}`,
            );
        }
    }
    return parsed;
}

function requirePositive(value, flag) {
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) {
        throw new ApiError(`${flag} must be a non-negative number, got "${value}"`);
    }
    return num;
}

// The API accepts a bare date as well as a full timestamp, so "2026-07-01" is
// passed through untouched rather than being expanded here.
export function buildFilter(options = {}) {
    const filter = options.filter ? parseRawFilter(options.filter) : [];
    if (options.from) {
        filter.push({ property: "timestamp", operator: "gte", value: options.from });
    }
    if (options.to) {
        filter.push({ property: "timestamp", operator: "lte", value: options.to });
    }
    if (options.caller) {
        filter.push({ property: "caller", operator: "like", value: options.caller });
    }
    if (options.called) {
        filter.push({ property: "called", operator: "like", value: options.called });
    }
    if (options.minDuration !== undefined) {
        filter.push({ property: "duration", operator: "gte", value: requirePositive(options.minDuration, "--min-duration") });
    }
    if (options.maxDuration !== undefined) {
        filter.push({ property: "duration", operator: "lte", value: requirePositive(options.maxDuration, "--max-duration") });
    }
    if (options.type) {
        filter.push({ property: "type", operator: "eq", value: options.type });
    }
    return filter;
}

// Pages until `total` rows have been collected. The page guard exists because a
// server that always returns rows would otherwise loop forever; an empty page
// also ends the walk, since that is how the API signals it has run out.
export async function listRecordings(client, { filter = [], limit = 25, page = 1, all = false, sort = "id", dir = "DESC", onPage } = {}) {
    const pageSize = all ? 100 : limit;
    const collected = [];
    let current = page;
    let total = 0;

    for (let guard = 0; guard < 1000; guard += 1) {
        const body = await client.list(RESOURCE, { limit: pageSize, page: current, filter, sort, dir });
        const rows = body?.data ?? [];
        total = body?.total ?? rows.length;
        collected.push(...rows);
        if (onPage) {
            onPage({ page: current, received: rows.length, collected: collected.length, total });
        }
        if (!all || rows.length === 0 || collected.length >= total) {
            break;
        }
        current += 1;
    }

    return { data: all ? collected : collected.slice(0, limit), total };
}
