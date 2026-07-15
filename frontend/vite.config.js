import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
    plugins: [react(), tailwindcss()],
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
