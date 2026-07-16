import { scan } from 'react-scan' // must be the first import: patches in before React loads
import { GoogleOAuthProvider } from '@react-oauth/google'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { router } from './router.jsx'

if (import.meta.env.DEV) scan({ enabled: true })

// React Query Cache Manager
const queryClient = new QueryClient({
    defaultOptions: {queries: { retry: 1, refetchOnWindowFocus: false }}
})

// Mantine (theme + Notifications) is mounted per-route in router.jsx's
// mantineLayoutRoute, not globally here — the landing page uses neither, so
// this keeps it out of the landing page's bundle. See MantineLayout.jsx.

// Checks the ID token's `aud` claim against (GOOGLE_CLIENT_ID in backend/infra/settings.py)
const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID || ''
createRoot(document.getElementById('root')).render(
    <StrictMode>
        <GoogleOAuthProvider clientId={googleClientId}>
            <QueryClientProvider client={queryClient}>
                <RouterProvider router={router} />
            </QueryClientProvider>
        </GoogleOAuthProvider>
    </StrictMode>,
)
