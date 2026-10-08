// Cloudflare Pages cannot run the tool itself, so every request to the pages.dev address is
// forwarded to the dashboard running on the PC, through the tunnel address in tunnel.json.
import tunnel from "../tunnel.json";

const offline = () =>
  new Response("The dashboard is offline. Start it on the PC with: node live.mjs", {
    status: 503,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

export async function onRequest({ request }) {
  if (!tunnel.url) return offline();
  const { pathname, search } = new URL(request.url);
  try {
    const response = await fetch(new Request(new URL(pathname + search, tunnel.url), request), { redirect: "manual" });
    // 530 = the tunnel address exists but nothing is connected behind it any more
    return response.status === 530 ? offline() : response;
  } catch {
    return offline();
  }
}
