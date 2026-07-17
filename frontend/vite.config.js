import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Mirrors, in dev, the routing DO App Platform's static-site spec does in prod:
// index_document="index.html" serves "/" only, catchall_document="app.html"
// serves every other (client-side-routed) path — see index.html/app.html for
// why (the landing-only Bg.webp preload). Without this, "vite dev" would fall
// back to its own default of serving index.html for every unmatched route.
function landingSplitDevRouting() {
    return {
        name: 'landing-split-dev-routing',
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                const url = req.url || ''
                const looksLikeAFile = /\.[a-zA-Z0-9]+(\?|$)/.test(url)
                const isClientRoute =
                    req.method === 'GET' &&
                    url !== '/' &&
                    !url.startsWith('/api') &&
                    !url.startsWith('/@') &&
                    !url.startsWith('/src/') &&
                    !url.startsWith('/node_modules/') &&
                    !looksLikeAFile
                if (isClientRoute) req.url = '/app.html'
                next()
            })
        },
    }
}

// https://vite.dev/config/
export default defineConfig({
    plugins: [react(), tailwindcss(), landingSplitDevRouting()],
    server: {
        // Proxy API calls to the backend so the browser sees frontend and backend
        // as the same origin locally too, matching production's path-based routing
        // under one domain (see admin_auth.py's admin_session cookie, which is
        // SameSite=Lax and gets silently rejected by the browser without this —
        // it relies on first-party/same-origin, not cross-site CORS).
        proxy: {
            '/api': {
                target: 'http://127.0.0.1:8000',
                changeOrigin: true,
                ws: true,
            },
        },
    },
    build: {
        rollupOptions: {
            // Multi-page build: index.html (landing, "/") and app.html (every
            // other route) so only the landing page's built HTML preloads
            // Bg.webp — see index.html's comment.
            input: {
                main: 'index.html',
                app: 'app.html',
            },
        },
    },
    test: {
        globals: true,
        environment: 'jsdom',
        setupFiles: './src/test/setup.js',
        // Playwright specs live under e2e/ and run via their own runner.
        exclude: ['**/node_modules/**', '**/e2e/**'],
        // client.js reads VITE_API_BASE at module load; pin it for deterministic
        // URL assertions (API + WebSocket base).
        env: { VITE_API_BASE: 'http://api.test' },
    },
})
