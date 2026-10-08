const API_PATH = "/v1.2/voipstudio";

export const ENV_HOSTS = {
    prod: "https://l7api.com",
    dev: "https://api.l7dev.co.cc",
    test: "https://api.l7test.co.cc",
};

export class ApiError extends Error {
    constructor(message, { status = null, body = null } = {}) {
        super(message);
        this.name = "ApiError";
        this.status = status;
        this.body = body;
    }
}

// An explicit --api-url wins over the environment variable, which wins over the
// named environment. Anything but `prod` is a Level 7 internal host.
export function resolveApiUrl({ apiUrl, env: name, processEnv = process.env } = {}) {
    const explicit = apiUrl || processEnv.VOIPSTUDIO_API_URL;
    if (explicit) {
        return explicit.replace(/\/+$/, "");
    }
    const host = ENV_HOSTS[name || processEnv.VOIPSTUDIO_ENV || "prod"];
    if (!host) {
        throw new ApiError(
            `Unknown environment "${name || processEnv.VOIPSTUDIO_ENV}" — expected one of: ${Object.keys(ENV_HOSTS).join(", ")}`,
        );
    }
    return `${host}${API_PATH}`;
}

function messageFrom(body, fallback) {
    return body?.errors?.[0]?.message ?? body?.message ?? fallback;
}

export class Client {
    constructor({ baseUrl, token = null, fetchImpl = globalThis.fetch } = {}) {
        this.baseUrl = baseUrl;
        this.token = token;
        this.fetchImpl = fetchImpl;
    }

    headers(extra = {}) {
        return this.token ? { "x-auth-token": this.token, ...extra } : { ...extra };
    }

    async request(path, { method = "GET", body, headers = {}, raw = false } = {}) {
        const init = { method, headers: this.headers(headers) };
        if (body !== undefined) {
            init.headers["Content-Type"] = "application/json";
            init.body = JSON.stringify(body);
        }
        const res = await this.fetchImpl(`${this.baseUrl}${path}`, init);
        if (raw) {
            if (!res.ok) {
                throw new ApiError(`Request to ${path} failed (HTTP ${res.status})`, { status: res.status });
            }
            return res;
        }
        // 204 has no body at all, so parsing it would throw on valid success.
        const parsed = res.status === 204 ? null : await res.json().catch(() => null);
        if (!res.ok) {
            throw new ApiError(messageFrom(parsed, `Request to ${path} failed (HTTP ${res.status})`), {
                status: res.status,
                body: parsed,
            });
        }
        return parsed;
    }

    get(path, options) {
        return this.request(path, options);
    }

    post(path, body, options) {
        return this.request(path, { ...options, method: "POST", body });
    }

    delete(path, options) {
        return this.request(path, { ...options, method: "DELETE" });
    }

    // The collection endpoints take filter as a JSON-encoded array of
    // {property, operator, value} objects, alongside paging and sort params.
    list(resource, { limit, page, filter, sort, dir } = {}) {
        const url = new URL(`${this.baseUrl}/${resource}`);
        if (limit !== undefined) {
            url.searchParams.set("limit", String(limit));
        }
        if (page !== undefined) {
            url.searchParams.set("page", String(page));
        }
        if (filter !== undefined) {
            url.searchParams.set("filter", JSON.stringify(filter));
        }
        if (sort) {
            url.searchParams.set("sort", sort);
        }
        if (dir) {
            url.searchParams.set("dir", dir);
        }
        return this.request(url.toString().slice(this.baseUrl.length));
    }
}
