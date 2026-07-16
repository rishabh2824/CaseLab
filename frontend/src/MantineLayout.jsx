import { createTheme, MantineProvider } from '@mantine/core'
import { Notifications } from '@mantine/notifications'
import '@mantine/core/styles.css'
import '@mantine/notifications/styles.css'

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

// Only the student + admin routes need Mantine (theme, Notifications) — the
// landing page uses neither, so this is mounted as a lazy route-level layout
// rather than a global provider in main.jsx, keeping Mantine out of the
// landing page's bundle entirely (see router.jsx's mantineLayoutRoute).
function MantineLayout({ children }) {
    return (
        <MantineProvider theme={mantineTheme}>
            <Notifications position="top-left" />
            {children}
        </MantineProvider>
    )
}

export default MantineLayout
