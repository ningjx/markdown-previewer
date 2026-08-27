/**
 * md-editor-ink — Cloudflare Worker 入口
 *
 * 静态资源（index.html / app.css / app.js）由 Workers Assets 直接分发；
 * 本 Worker 只处理非资源请求，并演示 Assets binding 的现代用法。
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 健康检查：验证 Worker + Assets 组合链路
    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, service: "md-editor-ink" });
    }

    // 其余请求回退到 Assets。
    // 未匹配到任何资源的路径由 not_found_handling: "single-page-application"
    // 返回 index.html（SPA 回退），见 wrangler.jsonc。
    return env.ASSETS.fetch(request);
  },
};
