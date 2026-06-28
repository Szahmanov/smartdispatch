// netlify/functions/fuel.js
// The agent fetches current Bulgarian fuel prices itself — the user never types a price.
// Best-effort live read with a reliable, recent national-average fallback. No API key needed.

const FALLBACK = {
  currency: "EUR",
  prices: { petrol: 1.49, diesel: 1.50, lpg: 0.64 }, // BG national averages, late June 2026
  source: "нац. средна (юни 2026)",
  sourceUrl: "https://bg.fuelo.net",
  live: false,
};

function num(s) { if (s == null) return null; const m = String(s).replace(",", ".").match(/(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : null; }
function ok(body) { return { statusCode: 200, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" }, body: JSON.stringify(body) }; }

exports.handler = async () => {
  const today = new Date().toISOString().slice(0, 10);
  // Try karai.bg, which publishes clean national average prices updated hourly.
  try {
    const r = await fetch("https://karai.bg/fuel-prices", { headers: { "User-Agent": "SmartDispatch/3.0 (StaGove autonomous logistics agent)" } });
    if (r.ok) {
      const html = (await r.text()).toLowerCase();
      const grab = (labels) => {
        for (const l of labels) {
          const re = new RegExp(l + "[^0-9€$]{0,18}€?\\s*([0-9]+[.,][0-9]{2})", "i");
          const m = html.match(re);
          const v = m && num(m[1]);
          if (v && v > 0.2 && v < 5) return v; // sanity bounds (EUR/L)
        }
        return null;
      };
      const diesel = grab(["дизел", "diesel"]);
      const petrol = grab(["а95", "a95", "бензин", "petrol"]);
      const lpg = grab(["lpg", "автогаз", "пропан"]);
      if (diesel && petrol) {
        return ok({ currency: "EUR", prices: { petrol, diesel, lpg: lpg || FALLBACK.prices.lpg }, source: "karai.bg", sourceUrl: "https://karai.bg/fuel-prices", date: today, live: true });
      }
    }
  } catch (e) { /* fall through to fallback */ }
  return ok(Object.assign({ date: today }, FALLBACK));
};
