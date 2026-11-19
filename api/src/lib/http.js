// Shared helpers for the HTTP functions.

function reply(status, body, maxAgeSeconds = 0) {
    return {
        status,
        jsonBody: body,
        headers: { 'Cache-Control': maxAgeSeconds ? `public, max-age=${maxAgeSeconds}` : 'no-store' },
    };
}

// Optional protection: if the ACCESS_CODE app setting is set, requests must
// send it in the x-access-code header. The page asks for it once.
function checkAccess(request) {
    const code = process.env.ACCESS_CODE;
    if (!code) return null;
    if (request.headers.get('x-access-code') === code) return null;
    return reply(401, { error: 'Enter the calendar access code.', needsCode: true });
}

// Turn unexpected errors into a clean message (details go to the logs).
async function guarded(context, fn) {
    try {
        return await fn();
    } catch (err) {
        context.error(err.stack || err.message);
        const config = /storage connection/i.test(err.message);
        return reply(500, { error: config ? err.message : 'Something went wrong on the server. Try again in a minute.' });
    }
}

module.exports = { reply, checkAccess, guarded };
