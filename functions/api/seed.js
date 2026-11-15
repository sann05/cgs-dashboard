// The hosted copy has no data/ to migrate from: every browser starts empty.
export const onRequestGet = () => Response.json({ error: "no saved data" }, { status: 404 });
