import { Lotto } from "./lotto.js";

export { Lotto };

function stub(env) {
  return env.LOTTO.get(env.LOTTO.idFromName("nyanlotto"));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/") || url.pathname === "/tick") {
      return stub(env).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(stub(env).fetch("https://nyanlotto/tick"));
  },
};
