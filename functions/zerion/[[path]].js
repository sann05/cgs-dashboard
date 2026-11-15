// Zerion answers browsers only from localhost, so the page asks this copy's
// /zerion/v1/wallets/… instead; the key (ZERION_API_KEY secret) is added here
// and never reaches the browser. server.py does the same locally.
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/zerion\//, "");
  if (!env.ZERION_API_KEY || !path.startsWith("v1/wallets/")) return Response.json({ error: "not found" }, { status: 404 });
  const r = await fetch(`https://api.zerion.io/${path}${url.search}`, {
    headers: { Authorization: `Basic ${btoa(`${env.ZERION_API_KEY}:`)}`, Accept: "application/json", "User-Agent": "cgs-dashboard" },
  });
  return new Response(r.body, { status: r.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
