/**
 * Current conditions for the top bar.
 *
 * Open-Meteo needs no key and no attribution beacon. One reading is shared by
 * every box in the property - it is the same weather - and cached for half an
 * hour so a hundred TVs waking at 07:00 make one request, not a hundred.
 */
import { config } from './config.js';

let cached = { at: 0, value: null };
let inflight = null;

/** WMO weather codes, collapsed to what a one-line status bar can show. */
function describe(code) {
  if (code === 0) return { icon: 'sun', key: 'clear' };
  if (code <= 2) return { icon: 'sun-cloud', key: 'partly' };
  if (code === 3) return { icon: 'cloud', key: 'cloudy' };
  if (code <= 48) return { icon: 'fog', key: 'fog' };
  if (code <= 67) return { icon: 'rain', key: 'rain' };
  if (code <= 77) return { icon: 'snow', key: 'snow' };
  if (code <= 82) return { icon: 'rain', key: 'showers' };
  if (code <= 86) return { icon: 'snow', key: 'snow' };
  return { icon: 'storm', key: 'storm' };
}

export async function current() {
  if (cached.value && Date.now() - cached.at < config.weather.ttlMs) return cached.value;
  if (inflight) return inflight;

  const url =
    'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${config.weather.lat}&longitude=${config.weather.lon}` +
    '&current=temperature_2m,weather_code&timezone=auto';

  inflight = (async () => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`weather ${res.status}`);
      const data = await res.json();
      const c = data.current ?? {};
      const value = {
        temp: Math.round(Number(c.temperature_2m)),
        ...describe(Number(c.weather_code)),
      };
      cached = { at: Date.now(), value };
      return value;
    } catch {
      // A status bar is not worth an error state; keep the last good reading,
      // or say nothing at all.
      return cached.value;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}
