import { createTheme, MantineProvider } from '@mantine/core'
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

// Brand the Mantine-based admin case builder so it matches the rest of the
// app (which is Tailwind, styled from index.css): Wisconsin red as the
// primary color, the same self-hosted brand fonts, and a slightly rounder
// default radius. Without this, Mantine's default blue/Inter look makes the
// case form feel like a different product from the landing/admin pages.
const mantineTheme = createTheme({
    fontFamily: '"IBM Plex Sans", sans-serif',
    headings: { fontFamily: '"Space Grotesk", sans-serif' },
    primaryColor: 'wisconsin',
    primaryShade: 6,
    defaultRadius: 'md',
    colors: {
        // 10-shade scale required by Mantine; shade 6 is the WSB red used on
        // the landing page (#c5050c), darker shades for hover/active.
        wisconsin: [
            '#fdecec',
            '#f8d3d3',
            '#efa9a9',
            '#e67c7c',
            '#de5555',
            '#d93c3c',
            '#c5050c',
            '#9c0409',
            '#780307',
            '#560205',
        ],
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
                <MantineProvider theme={mantineTheme}>
                    <Notifications position="top-left" />
                    <RouterProvider router={router} />
                </MantineProvider>
            </QueryClientProvider>
        </GoogleOAuthProvider>
    </StrictMode>,
)
