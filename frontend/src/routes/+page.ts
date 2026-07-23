// Landing is the one route that benefits from real prerendered HTML —
// overrides the root layout's ssr=false so `/` ships as static markup.
export const prerender = true;
export const ssr = true;
