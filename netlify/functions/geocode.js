// netlify/functions/geocode.js
// Proxies a single geocoding query to Nominatim (OpenStreetMap).
// Runs server-side so we can send a valid User-Agent (required by Nominatim's policy)
// and avoid browser CORS / rate issues. No API key needed.

exports.handler = async (event) => {
  const q = (event.queryStringParameters && event.queryStringParameters.q) || "";
  if (!q.trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing q parameter" }) };
  }

  const url =
    "https://nominatim.openstreetmap.org/search" +
    "?format=json&limit=1&accept-language=bg&countrycodes=bg" +
    "&q=" + encodeURIComponent(q);

  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": "SmartDispatch/2.0 (StaGove autonomous logistics agent)",
        Accept: "application/json",
      },
    });
    const data = await r.json();
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: "Geocoding request failed", detail: String(err) }),
    };
  }
};
