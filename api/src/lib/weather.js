// Open-Meteo helpers: ZIP -> coordinates, coordinates -> hourly forecast.
// Open-Meteo needs no API key for non-commercial use. If you ever need the
// commercial plan, set OPEN_METEO_API_KEY in the Static Web App's settings.

const API_KEY = process.env.OPEN_METEO_API_KEY || '';
const PREFIX = API_KEY ? 'customer-' : '';
const GEOCODE_URL = `https://${PREFIX}geocoding-api.open-meteo.com/v1/search`;
const FORECAST_URL = `https://${PREFIX}api.open-meteo.com/v1/forecast`;

const FORECAST_DAYS = 16;                       // Open-Meteo's maximum
const THUNDER_CODES = new Set([95, 96, 97, 99]); // WMO codes for thunderstorms

// "The service didn't answer" (as opposed to "that ZIP doesn't exist").
class UpstreamError extends Error {}

async function getJson(url, timeoutMs = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
        if (res.status === 404) return null;
        if (!res.ok) throw new UpstreamError(`${new URL(url).host} returned ${res.status}`);
        return await res.json();
    } catch (err) {
        if (err instanceof UpstreamError) throw err;
        throw new UpstreamError(`${new URL(url).host} did not respond: ${err.message}`);
    } finally {
        clearTimeout(timer);
    }
}

function withKey(params) {
    if (API_KEY) params.set('apikey', API_KEY);
    return params;
}

// Returns { latitude, longitude, place } or null if the ZIP doesn't exist.
// Throws UpstreamError if no geocoder could be reached.
async function geocodeZip(zip) {
    let reached = false;
    let looseMatch = null;

    // 1. Open-Meteo geocoding accepts postal codes as the search name.
    try {
        const params = withKey(new URLSearchParams({ name: zip, count: '10', countryCode: 'US', language: 'en', format: 'json' }));
        const data = await getJson(`${GEOCODE_URL}?${params}`);
        reached = true;
        const results = (data && data.results) || [];
        const exact = results.find((r) => Array.isArray(r.postcodes) && r.postcodes.includes(zip));
        if (exact) return toLocation(exact.latitude, exact.longitude, exact.name, exact.admin1);
        if (results[0]) looseMatch = toLocation(results[0].latitude, results[0].longitude, results[0].name, results[0].admin1);
    } catch (err) {
        if (!(err instanceof UpstreamError)) throw err;
    }

    // 2. Backup: Zippopotam.us, a free ZIP lookup with no key.
    try {
        const data = await getJson(`https://api.zippopotam.us/us/${zip}`);
        reached = true;
        const place = data && data.places && data.places[0];
        if (place) return toLocation(Number(place.latitude), Number(place.longitude), place['place name'], place['state abbreviation']);
    } catch (err) {
        if (!(err instanceof UpstreamError)) throw err;
    }

    if (looseMatch) return looseMatch;
    if (!reached) throw new UpstreamError('No ZIP lookup service responded');
    return null;
}

function toLocation(latitude, longitude, name, region) {
    return { latitude, longitude, place: [name, region].filter(Boolean).join(', ') };
}

// Returns { timezone, days: { 'YYYY-MM-DD': [hourly rows, indexed by hour] } }
async function fetchForecast(latitude, longitude) {
    const params = withKey(new URLSearchParams({
        latitude: latitude.toFixed(4),
        longitude: longitude.toFixed(4),
        hourly: 'temperature_2m,precipitation_probability,wind_speed_10m,wind_gusts_10m,weather_code',
        temperature_unit: 'fahrenheit',
        wind_speed_unit: 'mph',
        timezone: 'auto',               // times come back in the location's local time
        forecast_days: String(FORECAST_DAYS),
    }));
    const data = await getJson(`${FORECAST_URL}?${params}`);
    if (!data || !data.hourly || !Array.isArray(data.hourly.time)) {
        throw new UpstreamError('Open-Meteo returned no hourly data');
    }
    return { timezone: data.timezone, days: hourlyToDays(data.hourly) };
}

// Open-Meteo gives parallel arrays; the app wants rows grouped by date and hour.
function hourlyToDays(hourly) {
    const days = {};
    hourly.time.forEach((time, i) => {
        const tempF = hourly.temperature_2m?.[i];
        if (tempF == null) return;                    // no data for this hour
        const date = time.slice(0, 10);               // "2026-11-19T14:00" -> "2026-11-19"
        const hour = Number(time.slice(11, 13));
        const wind = hourly.wind_speed_10m?.[i] ?? 0;
        const code = hourly.weather_code?.[i] ?? null;
        if (!days[date]) days[date] = [];
        days[date][hour] = {
            hour,
            tempF,
            rain: hourly.precipitation_probability?.[i] ?? null,   // null = not available that far out
            windMph: wind,
            gustMph: hourly.wind_gusts_10m?.[i] ?? wind,
            storm: THUNDER_CODES.has(code),
            code,
        };
    });
    return days;
}

module.exports = { geocodeZip, fetchForecast, hourlyToDays, UpstreamError };
