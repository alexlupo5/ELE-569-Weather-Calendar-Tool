// Small JSON document store.
// In Azure it uses a private Blob Storage container. Each document is one
// JSON blob: plans.json, alerts.json, status.json, forecasts/02816.json.
// Updates use the blob's ETag, so two changes at the same moment can't
// overwrite each other; the loser just retries.
// With no storage connection configured (running on your Mac), it uses
// files in api/.data instead.

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const CONTAINER = process.env.DATA_CONTAINER || 'weatherguard-data';

function connectionString() {
    const candidates = [process.env.DATA_STORAGE_CONNECTION, process.env.AzureWebJobsStorage];
    return candidates.find((c) => c && (c.includes('AccountKey=') || c.startsWith('UseDevelopmentStorage'))) || null;
}

/* ---------------- Blob Storage ---------------- */

function blobBackend(conn) {
    const { BlobServiceClient } = require('@azure/storage-blob');
    let ready = null;

    function container() {
        if (!ready) {
            const client = BlobServiceClient.fromConnectionString(conn).getContainerClient(CONTAINER);
            ready = client.createIfNotExists().then(() => client).catch((err) => {
                ready = null;   // try again next time
                throw err;
            });
        }
        return ready;
    }

    async function streamToString(stream) {
        const chunks = [];
        for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        return Buffer.concat(chunks).toString('utf8');
    }

    return {
        async read(name) {
            const blob = (await container()).getBlockBlobClient(name);
            try {
                const res = await blob.download(0);
                return { data: JSON.parse(await streamToString(res.readableStreamBody)), etag: res.etag };
            } catch (err) {
                if (err.statusCode === 404) return null;
                throw err;
            }
        },
        // etag: undefined = overwrite, null = only if it doesn't exist yet, string = only if unchanged
        async write(name, data, etag) {
            const blob = (await container()).getBlockBlobClient(name);
            const body = JSON.stringify(data);
            const conditions = etag === undefined ? undefined : etag ? { ifMatch: etag } : { ifNoneMatch: '*' };
            try {
                await blob.upload(body, Buffer.byteLength(body), {
                    blobHTTPHeaders: { blobContentType: 'application/json' },
                    conditions,
                });
                return true;
            } catch (err) {
                if (err.statusCode === 412 || err.statusCode === 409) return false;   // someone else changed it
                throw err;
            }
        },
    };
}

/* ---------------- Local files (development) ---------------- */

function fileBackend(dir) {
    const fileFor = (name) => path.join(dir, name);
    const tagOf = (text) => crypto.createHash('sha1').update(text).digest('hex');
    return {
        async read(name) {
            try {
                const text = await fs.readFile(fileFor(name), 'utf8');
                return { data: JSON.parse(text), etag: tagOf(text) };
            } catch (err) {
                if (err.code === 'ENOENT') return null;
                throw err;
            }
        },
        async write(name, data, etag) {
            const file = fileFor(name);
            if (etag !== undefined) {
                const current = await this.read(name);
                if (etag === null ? current !== null : !current || current.etag !== etag) return false;
            }
            await fs.mkdir(path.dirname(file), { recursive: true });
            await fs.writeFile(file, JSON.stringify(data));
            return true;
        },
    };
}

/* ---------------- Pick one ---------------- */

let backend = null;
function getBackend() {
    if (backend) return backend;
    const conn = connectionString();
    if (conn) {
        backend = blobBackend(conn);
    } else if (process.env.WEBSITE_SITE_NAME) {
        // Running in Azure without storage configured: say exactly what to fix.
        throw new Error('No storage connection. Add a DATA_STORAGE_CONNECTION app setting with your storage account connection string.');
    } else {
        backend = fileBackend(process.env.DATA_DIR || path.join(__dirname, '..', '..', '.data'));
    }
    return backend;
}

async function readJson(name) {
    return getBackend().read(name);
}

async function writeJson(name, data) {
    await getBackend().write(name, data, undefined);
}

// Read a document, change it with `mutate(value)`, and save it, retrying if
// someone else saved in between. `fallback` is the starting value when the
// document doesn't exist yet. Returns the saved value.
async function updateJson(name, fallback, mutate, attempts = 6) {
    for (let i = 0; i < attempts; i++) {
        const current = await getBackend().read(name);
        const value = current ? current.data : structuredClone(fallback);
        const result = await mutate(value);
        const next = result === undefined ? value : result;
        if (await getBackend().write(name, next, current ? current.etag : null)) return next;
        await new Promise((r) => setTimeout(r, 50 + Math.random() * 150));
    }
    throw new Error(`Couldn't save ${name}: too many changes at once. Try again.`);
}

// For tests.
function _setBackend(b) { backend = b; }

module.exports = { readJson, writeJson, updateJson, _setBackend };
