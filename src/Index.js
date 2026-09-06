const STATIONS = {
  moena: { code: "T0096", name: "Moena (Diga Pezzè)" },
  gries: { code: "T0437", name: "Canazei (Gries)" },
  costalunga: { code: "T0094", name: "Passo Costalunga" },
  campitello: { code: "T0229", name: "Campitello (Malga Do Col D'Aura)" },
  fedaia: { code: "T0092", name: "Pian Fedaia (Diga)" },
  ciampac: { code: "T0403", name: "Canazei (Ciampac)" },
  sasdelmul: { code: "T0404", name: "Marmolada (Sas del Mul)" }
};

const API =
  "https://dati.meteotrentino.it/service.asmx/datiRealtimeUnaStazione";

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=120"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: HEADERS
  });
}

function latest(features, field) {
  for (const f of features) {
    const v = f?.properties?.[field];

    if (v !== "" && v !== null && v !== undefined) {
      const n = Number(String(v).replace(",", "."));
      return Number.isFinite(n) ? n : v;
    }
  }
  return null;
}

function windDirection(deg) {
  if (deg === null || deg === undefined || isNaN(deg)) return null;

  const dirs = [
    "N", "NNE", "NE", "ENE",
    "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW",
    "W", "WNW", "NW", "NNW"
  ];

  return dirs[Math.round(Number(deg) / 22.5) % 16];
}

function fixMeteoTrentinoTime(value) {
  if (!value) return null;

  const m = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/
  );

  if (!m) return value;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);

  const reference = new Date(
    Date.UTC(year, month - 1, day, 12, 0, 0)
  );

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Rome",
    timeZoneName: "shortOffset"
  }).formatToParts(reference);

  const tz =
    parts.find(p => p.type === "timeZoneName")?.value || "GMT+1";

  const isDST = tz.includes("+2") || tz.includes("+02");

  const corrected = new Date(
    Date.UTC(
      year,
      month - 1,
      day,
      hour + (isDST ? 1 : 0),
      minute,
      second
    )
  );

  const y = corrected.getUTCFullYear();
  const mo = String(corrected.getUTCMonth() + 1).padStart(2, "0");
  const d = String(corrected.getUTCDate()).padStart(2, "0");
  const h = String(corrected.getUTCHours()).padStart(2, "0");
  const mi = String(corrected.getUTCMinutes()).padStart(2, "0");
  const s = String(corrected.getUTCSeconds()).padStart(2, "0");

  return `${y}-${mo}-${d}T${h}:${mi}:${s}${isDST ? "+02:00" : "+01:00"}`;
}

async function fetchData(cfg) {
  const url =
    `${API}?stazione=${encodeURIComponent(cfg.code)}&h=1`;

  const response = await fetch(url, {
    cf: {
      cacheTtl: 120,
      cacheEverything: true
    }
  });

  if (!response.ok)
    throw new Error(`MeteoTrentino HTTP ${response.status}`);

  return response.json();
}

async function loadStation(id, cfg) {
  try {
    const data = await fetchData(cfg);
    const features = data?.features || [];

    if (!features.length)
      throw new Error("Nessun dato disponibile");

    const p = features[0]?.properties || {};
    const windDeg = latest(features, "dvmed(gN)");

    return {
      id,
      code: cfg.code,
      name: cfg.name,
      altitude: latest(features, "quota"),

      source: "MeteoTrentino",
      status: "online",

      updated: fixMeteoTrentinoTime(p.datetime),
      rawUpdated: p.datetime || null,

      temperature: latest(features, "ta(°C)"),
      humidity: latest(features, "umid(%)"),

      wind: latest(features, "vvmed(m/s)"),
      windDirectionDegrees: windDeg,
      windDirection: windDirection(windDeg),

      fetchedAt: new Date().toISOString()
    };

  } catch (err) {
    return {
      id,
      code: cfg.code,
      name: cfg.name,
      source: "MeteoTrentino",
      status: "error",
      error: String(err?.message || err),
      fetchedAt: new Date().toISOString()
    };
  }
}

async function rawStation(cfg) {
  try {
    const data = await fetchData(cfg);
    return json(data);

  } catch (err) {
    return json({
      error: String(err?.message || err)
    }, 502);
  }
}

export default {
  async fetch(request) {

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: HEADERS
      });
    }

    const url = new URL(request.url);

    // JSON originale MeteoTrentino
    // esempio: ?raw=sasdelmul
    if (url.searchParams.has("raw")) {
      const id = url.searchParams.get("raw");
      const cfg = STATIONS[id];

      if (!cfg) {
        return json({
          error: "Stazione sconosciuta",
          available: Object.keys(STATIONS)
        }, 404);
      }

      return rawStation(cfg);
    }

    // Elenco stazioni
    // ?stations
    if (url.searchParams.has("stations")) {
      return json({
        count: Object.keys(STATIONS).length,
        stations: Object.entries(STATIONS).map(
          ([id, s]) => ({
            id,
            code: s.code,
            name: s.name
          })
        )
      });
    }

    // Singola stazione
    // esempio: ?station=ciampac
    if (url.searchParams.has("station")) {
      const id = url.searchParams.get("station");
      const cfg = STATIONS[id];

      if (!cfg) {
        return json({
          error: "Stazione sconosciuta",
          available: Object.keys(STATIONS)
        }, 404);
      }

      return json(await loadStation(id, cfg));
    }

    // Tutte le stazioni in parallelo
    const stations = await Promise.all(
      Object.entries(STATIONS).map(
        ([id, cfg]) => loadStation(id, cfg)
      )
    );

    return json({
      version: "1.1",
      generatedAt: new Date().toISOString(),
      count: stations.length,
      stations
    });
  }
};
