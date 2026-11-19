// GET /api/forecast?zip=02816
// Returns the latest forecast for a ZIP: the one saved by the 30-minute
// background check, or a fresh download if there isn't a recent one.
//   { zip, place, latitude, longitude, timezone, issuedAt, source, days }

const { app } = require('@azure/functions');
const { getForecast, NotFoundError } = require('../lib/checker');
const { UpstreamError } = require('../lib/weather');
const { reply, guarded } = require('../lib/http');

async function handler(request, context) {
    return guarded(context, async () => {
        const zip = (request.query.get('zip') || '').trim();
        if (!/^\d{5}$/.test(zip)) return reply(400, { error: 'Enter a 5-digit US ZIP code.' });
        try {
            return reply(200, await getForecast(zip), 300);
        } catch (err) {
            if (err instanceof NotFoundError) return reply(404, { error: err.message });
            if (err instanceof UpstreamError) {
                context.error(`Forecast for ${zip} failed: ${err.message}`);
                return reply(502, { error: "The weather service isn't responding. Try again in a minute." });
            }
            throw err;
        }
    });
}

app.http('forecast', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'forecast',
    handler,
});

module.exports = { handler };
