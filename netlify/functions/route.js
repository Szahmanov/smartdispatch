// netlify/functions/route.js
// Proxies an OSRM driving-route request. No API key needed.
// Expects ?coords=lon,lat;lon,lat;...  (OSRM uses lon,lat order)
// Returns leg-by-leg driving durations in seconds.

exports.handler = async (event) => {
  const coords = (event.queryStringParameters && event.queryStringParameters.coords) || "";
  if (!coords.includes(";")) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Need at least two coordinate pairs in coords" }),
    };
  }

  const url =
    "https://router.project-osrm.org/route/v1/driving/" +
    coords +
    "?overview=false&annotations=duration";

  try {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    const data = await r.json();
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: "Routing request failed", detail: String(err) }),
    };
  }
};
