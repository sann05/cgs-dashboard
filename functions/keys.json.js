// What this copy offers the page: whether Zerion is set up (the key itself
// stays in the ZERION_API_KEY secret, see zerion/[[path]].js) and the
// WalletConnect project ID. The local server.py answers the same path from .env.
export const onRequestGet = ({ env }) =>
  Response.json(
    { zerion: Boolean(env.ZERION_API_KEY), walletconnect: env.WALLETCONNECT_PROJECT_ID || "" },
    { headers: { "Cache-Control": "no-store" } },
  );
