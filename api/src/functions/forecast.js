// GET /api/forecast?zip=02816
// Looks up the ZIP, gets a 16-day hourly forecast from Open-Meteo and returns
// it in the shape the calendar page expects:
//   { zip, place, latitude, longitude, timezone, issuedAt, source, days }

const { app } = require('@azure/functions');
const { geocodeZip, fetchForecast, UpstreamError } = require('../lib/weather');

// In-memory caches. They last while this Function instance stays warm, which
// is enough to stop every page load from hitting Open-Meteo. All plans in the
// same ZIP share one forecast.
const FORECAST_TTL_MS = 30 * 60 * 1000;          // Open-Meteo updates hourly
const LOCATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // ZIP coordinates rarely change
const forecastCache = new Map();
const locationCache = new Map();

function reply(status, body, maxAgeSeconds = 0) {
    return {
        status,
        jsonBody: body,
        headers: { 'Cache-Control': maxAgeSeconds ? `public, max-age=${maxAgeSeconds}` : 'no-store' },
    };
}

async function getLocation(zip) {
    const hit = locationCache.get(zip);
    if (hit && hit.expires > Date.now()) return hit.value;
    const value = await geocodeZip(zip);
    if (value) locationCache.set(zip, { value, expires: Date.now() + LOCATION_TTL_MS });
    return value;
}

async function handler(request, context) {
    const zip = (request.query.get('zip') || '').trim();
    if (!/^\d{5}$/.test(zip)) {
        return reply(400, { error: 'Enter a 5-digit US ZIP code.' });
    }

    const cached = forecastCache.get(zip);
    if (cached && cached.expires > Date.now()) {
        return reply(200, cached.data, 600);
    }

    try {
        const location = await getLocation(zip);
        if (!location) {
            return reply(404, { error: `Couldn't find ZIP code ${zip}. Check the number and try again.` });
        }

        const forecast = await fetchForecast(location.latitude, location.longitude);
        const data = {
            zip,
            place: location.place,
            latitude: location.latitude,
            longitude: location.longitude,
            timezone: forecast.timezone,
            issuedAt: Date.now(),
            source: 'Open-Meteo',
            days: forecast.days,
        };
        forecastCache.set(zip, { data, expires: Date.now() + FORECAST_TTL_MS });
        return reply(200, data, 600);
    } catch (err) {
        context.error(`Forecast for ${zip} failed: ${err.message}`);
        // An old forecast beats no forecast while Open-Meteo is unreachable.
        if (cached) return reply(200, { ...cached.data, stale: true });
        if (err instanceof UpstreamError) {
            return reply(502, { error: "The weather service isn't responding. Try again in a minute." });
        }
        return reply(500, { error: 'Something went wrong getting the forecast.' });
    }
}

app.http('forecast', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'forecast',
    handler,
});

module.exports = { handler };
