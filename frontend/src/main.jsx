import { scan } from 'react-scan' // must be the first import: patches in before React loads
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

if (import.meta.env.DEV) scan({ enabled: true })

// React Query Cache Manager
const queryClient = new QueryClient({
    defaultOptions: {queries: { retry: 1, refetchOnWindowFocus: false }}
})

// Override Mantine UI's default theme with custom theme
const mantineTheme = createTheme({
    fontFamily: '"IBM Plex Sans", sans-serif',
    headings: { fontFamily: '"Space Grotesk", sans-serif' },
    primaryColor: 'wisconsin',
    primaryShade: 6,
    defaultRadius: 'md',
    colors: {
        // 10-shade scale required by Mantine
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

// Checks the ID token's `aud` claim against (GOOGLE_CLIENT_ID in backend/infra/settings.py)
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
