import { MantineProvider } from '@mantine/core'
import { Notifications } from '@mantine/notifications'
import { GoogleOAuthProvider } from '@react-oauth/google'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@mantine/core/styles.css'
import '@mantine/notifications/styles.css'
import './index.css'
import { router } from './router.jsx'

const queryClient = new QueryClient({
    defaultOptions: {
        queries: { retry: 1, refetchOnWindowFocus: false },
    },
})

// Same Google OAuth client id the backend checks the ID token's `aud` claim
// against (GOOGLE_CLIENT_ID in backend/settings.py) — see
// components/SignInButton.jsx.
const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID || ''

createRoot(document.getElementById('root')).render(
    <StrictMode>
        <GoogleOAuthProvider clientId={googleClientId}>
            <QueryClientProvider client={queryClient}>
                <MantineProvider>
                    <Notifications position="top-left" />
                    <RouterProvider router={router} />
                </MantineProvider>
            </QueryClientProvider>
        </GoogleOAuthProvider>
    </StrictMode>,
)
