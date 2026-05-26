const TRELLO_API_ORIGIN = "https://api.trello.com";
const TRELLO_AUTH_URL = "https://trello.com/1/authorize";
const CONNECTOR_NAME = "Freshdesk Trello Connector";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization,Content-Type",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      const trelloAppKey = normalizeText(env.TRELLO_APP_KEY);
      if (!trelloAppKey) {
        return json({ error: "Bridge is missing TRELLO_APP_KEY." }, 500);
      }

      const url = new URL(request.url);
      if (url.pathname === "/trello/authorize-url") {
        return handleAuthorizeUrl(url, trelloAppKey);
      }

      if (!url.pathname.startsWith("/trello/")) {
        return json({ error: "Not found." }, 404);
      }

      return proxyTrelloRequest(request, url, trelloAppKey);
    } catch (error) {
      return json(
        { error: error && error.message ? error.message : "Bridge error." },
        500,
      );
    }
  },
};

function handleAuthorizeUrl(url, trelloAppKey) {
  const returnUrl = normalizeText(url.searchParams.get("return_url"));
  if (!returnUrl) {
    return json({ error: "return_url is required." }, 400);
  }

  const authorizeUrl = new URL(TRELLO_AUTH_URL);
  authorizeUrl.searchParams.set("callback_method", "fragment");
  authorizeUrl.searchParams.set("expiration", "never");
  authorizeUrl.searchParams.set("key", trelloAppKey);
  authorizeUrl.searchParams.set("name", CONNECTOR_NAME);
  authorizeUrl.searchParams.set("response_type", "token");
  authorizeUrl.searchParams.set("return_url", returnUrl);
  authorizeUrl.searchParams.set("scope", "read,write,account");

  return json({ authorize_url: authorizeUrl.toString() });
}

async function proxyTrelloRequest(request, url, trelloAppKey) {
  const trelloToken = getBearerToken(request);
  if (!trelloToken) {
    return json({ error: "Bearer Trello token is required." }, 401);
  }

  const targetUrl = buildTrelloProxyUrl(url, trelloAppKey, trelloToken);
  const init = {
    method: request.method,
    headers: {
      "Content-Type": request.headers.get("Content-Type") || "application/json",
    },
  };

  if (!["GET", "HEAD"].includes(request.method.toUpperCase())) {
    init.body = await request.text();
  }

  const response = await fetch(targetUrl, init);
  const body = await response.text();
  return new Response(body, {
    status: response.status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type":
        response.headers.get("Content-Type") || "application/json",
    },
  });
}

function buildTrelloProxyUrl(url, trelloAppKey, trelloToken) {
  const bridgePath = url.pathname.replace(/^\/trello/, "");
  const targetPath =
    bridgePath === "/tokens/webhooks"
      ? `/1/tokens/${encodeURIComponent(trelloToken)}/webhooks`
      : `/1${bridgePath}`;

  const targetUrl = new URL(targetPath, TRELLO_API_ORIGIN);
  url.searchParams.forEach((value, key) => {
    targetUrl.searchParams.set(key, value);
  });

  targetUrl.searchParams.set("key", trelloAppKey);
  if (bridgePath !== "/tokens/webhooks") {
    targetUrl.searchParams.set("token", trelloToken);
  }

  return targetUrl.toString();
}

function getBearerToken(request) {
  const authorization = normalizeText(request.headers.get("Authorization"));
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? normalizeText(match[1]) : "";
}

function normalizeText(value) {
  return String(value || "").trim();
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
    },
  });
}
