// netlify/functions/groq.js
// Proxies chat-completion requests to Groq so the GROQ_API_KEY never reaches the browser.
// Reads the key from a Netlify Environment Variable named GROQ_API_KEY.

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "GROQ_API_KEY is not configured on the server." }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  const body = {
    model: payload.model || "llama-3.3-70b-versatile",
    messages: payload.messages || [],
    temperature: payload.temperature ?? 0.1,
    max_tokens: payload.max_tokens || 4096,
  };
  if (payload.response_format) body.response_format = payload.response_format;

  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    return {
      statusCode: r.status,
      headers: { "Content-Type": "application/json" },
      body: text,
    };
  } catch (err) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: "Upstream request to Groq failed", detail: String(err) }),
    };
  }
};
