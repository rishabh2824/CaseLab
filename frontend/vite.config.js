import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) => filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			// SPA: no server-rendering (see root +layout.js), static-hosted, client
			// routing needs the same fallback shim SvelteKit gives us for free.
			adapter: adapter({ fallback: '200.html' })
		})
	],
	server: {
		// Proxy API calls to the backend so the browser sees frontend and backend
		// as the same origin locally too, matching production's path-based routing
		// under one domain (see backend/services/admin_auth.py's admin_session
		// cookie, which is SameSite=Lax and gets silently rejected by the browser
		// without this — it relies on first-party/same-origin, not cross-site CORS).
		proxy: {
			'/api': {
				target: 'http://127.0.0.1:8000',
				changeOrigin: true,
				ws: true
			}
		}
	},
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.js',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}'],
					// client.js reads VITE_API_BASE at module load; pin it for
					// deterministic URL assertions (mirrors the old frontend/vite.config.js).
					env: { VITE_API_BASE: 'http://api.test' }
				}
			}
		]
	}
});
