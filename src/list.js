import { ApiError } from "./api.js";

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

function requireNumber(value, flag) {
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) {
        throw new ApiError(`--${flag} must be a non-negative number, got "${value}"`);
    }
    return num;
}

// commander hands options back camelCased, so --min-duration arrives as
// minDuration; the entity definitions are written with the flag spelling.
function camel(flag) {
    return flag.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

// Each entity dates itself under a different property - timestamp, origtime,
// created_at, calldate - so --from/--to resolve through the entity rather than
// being hardcoded.
export function buildFilter(spec, options = {}) {
    const filter = options.filter ? parseRawFilter(options.filter) : [];

    if (options.from) {
        filter.push({ property: spec.dateField, operator: "gte", value: options.from });
    }
    if (options.to) {
        filter.push({ property: spec.dateField, operator: "lte", value: options.to });
    }

    for (const [flag, def] of Object.entries(spec.filters ?? {})) {
        const value = options[camel(flag)];
        if (value === undefined || value === null || value === "") {
            continue;
        }
        filter.push({
            property: def.property,
            operator: def.operator,
            value: def.numeric ? requireNumber(value, flag) : value,
        });
    }

    return filter;
}

// Pages until `total` rows have been collected. The page guard exists because a
// server that always returns rows would otherwise loop forever; an empty page
// also ends the walk, since that is how the API signals it has run out.
export async function listEntity(client, spec, { filter = [], limit = 25, page = 1, all = false, sort = "id", dir = "DESC", onPage } = {}) {
    const pageSize = all ? 100 : limit;
    const collected = [];
    let current = page;
    let total = 0;

    for (let guard = 0; guard < 1000; guard += 1) {
        const body = await client.list(spec.resource, { limit: pageSize, page: current, filter, sort, dir });
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
