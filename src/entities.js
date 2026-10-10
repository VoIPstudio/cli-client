// One definition per entity the CLI exposes. Everything that differs between
// them lives here: the API resource, which field holds the date, which filter
// flags map to which properties, and how a downloaded file is named.
//
// The field names are not guessable and were read off the live API rather than
// assumed - each entity dates itself differently (timestamp, origtime,
// created_at, calldate) and names its endpoints differently (caller/called,
// caller/dialled, from/to, src/dst).

// Filters shared by anything with a duration.
const DURATION_FILTERS = {
    "min-duration": { property: "duration", operator: "gte", numeric: true },
    "max-duration": { property: "duration", operator: "lte", numeric: true },
};

export const ENTITIES = {
    recording: {
        resource: "monitors",
        noun: "recording",
        plural: "recordings",
        dateField: "timestamp",
        // The record's `size` matches the delivered bytes exactly, so it is
        // usable as a truncation check. Most other entities have no such field.
        sizeField: "size",
        download: { extension: "mp3", path: (id) => `/monitors/${encodeURIComponent(id)}.mp3` },
        columns: ["id", "timestamp", "caller", "called", "duration", "type"],
        nameParts: (r) => [r.timestamp, [r.caller, r.called]],
        filters: {
            caller: { property: "caller", operator: "like" },
            called: { property: "called", operator: "like" },
            type: { property: "type", operator: "eq" },
            ...DURATION_FILTERS,
        },
    },

    voicemail: {
        resource: "voicemessages",
        noun: "voicemail",
        plural: "voicemails",
        dateField: "origtime",
        sizeField: null, // no size field: see docs/README on the unverifiable length
        download: { extension: "mp3", path: (id) => `/voicemessages/${encodeURIComponent(id)}.mp3` },
        columns: ["id", "origtime", "caller", "dialled", "duration", "folder", "is_new"],
        nameParts: (r) => [r.origtime, [r.caller, r.dialled]],
        filters: {
            caller: { property: "caller", operator: "like" },
            dialled: { property: "dialled", operator: "like" },
            folder: { property: "folder", operator: "eq" },
            ...DURATION_FILTERS,
        },
    },

    fax: {
        resource: "faxes",
        noun: "fax",
        plural: "faxes",
        dateField: "created_at",
        sizeField: null,
        download: { extension: "pdf", path: (id) => `/faxes/${encodeURIComponent(id)}.pdf` },
        // The API supplies a filename of its own here, matching what the
        // dashboard offers; preferring it keeps the two consistent.
        filenameField: "filename",
        columns: ["id", "created_at", "from", "to", "pages", "status", "type"],
        nameParts: (r) => [r.created_at, [r.from, r.to]],
        // The API rejects `from` and `to` here with "Filtration error" under
        // every operator, so fax deliberately has no number filters - offering
        // --sender/--recipient would just hand the user a guaranteed error.
        filters: {
            status: { property: "status", operator: "eq" },
            type: { property: "type", operator: "eq" },
            filename: { property: "filename", operator: "like" },
        },
    },

    invoice: {
        resource: "transactions",
        noun: "invoice",
        plural: "invoices",
        dateField: "created_at",
        sizeField: null,
        download: { extension: "pdf", path: (id) => `/transactions/${encodeURIComponent(id)}.pdf` },
        // An incomplete transaction has no PDF yet. That is a state, not a
        // failure, so it is reported as skipped and does not fail the batch.
        skipWhen: (message) => /not completed yet/i.test(message),
        columns: ["id", "created_at", "amount", "currency_iso", "type", "result"],
        nameParts: (r) => [r.created_at, [r.amount && `${r.amount}${r.currency_iso ?? ""}`]],
        filters: {
            "min-amount": { property: "amount", operator: "gte", numeric: true },
            "max-amount": { property: "amount", operator: "lte", numeric: true },
            type: { property: "type", operator: "eq" },
        },
    },

    cdr: {
        resource: "cdrs",
        noun: "CDR",
        plural: "CDRs",
        dateField: "calldate",
        download: null, // no per-record file; bulk export is an async task
        columns: ["id", "calldate", "src", "dst", "duration", "billsec", "disposition"],
        filters: {
            src: { property: "src", operator: "like" },
            dst: { property: "dst", operator: "like" },
            disposition: { property: "disposition", operator: "eq" },
            type: { property: "type", operator: "eq" },
            ...DURATION_FILTERS,
        },
    },

    sms: {
        resource: "sms",
        noun: "SMS message",
        plural: "SMS messages",
        dateField: "created_at",
        download: null,
        columns: ["id", "created_at", "from", "to", "type", "message"],
        filters: {
            sender: { property: "from", operator: "like" },
            recipient: { property: "to", operator: "like" },
            type: { property: "type", operator: "eq" },
        },
    },

    conversation: {
        resource: "conversations",
        noun: "conversation",
        plural: "conversations",
        dateField: "created_at",
        download: null,
        columns: ["id", "created_at", "channel", "src", "dst", "duration", "type"],
        filters: {
            src: { property: "src", operator: "like" },
            dst: { property: "dst", operator: "like" },
            channel: { property: "channel", operator: "eq" },
            type: { property: "type", operator: "eq" },
            ...DURATION_FILTERS,
        },
    },
};

export function entity(name) {
    const spec = ENTITIES[name];
    if (!spec) {
        throw new Error(`unknown entity "${name}" - expected one of: ${Object.keys(ENTITIES).join(", ")}`);
    }
    return spec;
}

export const DOWNLOADABLE = Object.entries(ENTITIES)
    .filter(([, spec]) => spec.download)
    .map(([name]) => name);
