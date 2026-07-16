import {createRootRoute, createRoute, createRouter, Outlet, redirect} from '@tanstack/react-router'
import { lazy, Suspense } from 'react'
import { ADMIN_ROLE } from './constants.js'
import { useSessionStore } from './hooks/sessionStore.js'
import LandingHome from './pages/Home.jsx'

// Keep the admin flow out of simulation workflow loads
const Admins = lazy(() => import('./pages/admin/Admins.jsx'))
const CreateCase = lazy(() => import('./pages/admin/CreateCase.jsx'))
const CaseForm = lazy(() => import('./pages/admin/caseForm.jsx'))
const AdminHome = lazy(() => import('./pages/admin/Home.jsx'))
const TemplatePicker = lazy(() => import('./pages/admin/TemplatePicker.jsx'))
// Lazy so the landing bundle never pulls in @mantine/notifications' store
// module (Home calls notifications.show(), which requires MantineProvider —
// see mantineLayoutRoute below).
const Home = lazy(() => import('./pages/student/Home.jsx'))
// Only student + admin need Mantine — lazy so landing's bundle never loads it.
const MantineLayout = lazy(() => import('./MantineLayout.jsx'))

const rootRoute = createRootRoute({
    component: () => (<Suspense fallback={null}><Outlet /></Suspense>)})

const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: LandingHome,
})

// Pathless layout route: wraps student + admin in Mantine (theme +
// Notifications) without adding a path segment. Landing stays a sibling of
// this route, outside the Mantine tree entirely.
const mantineLayoutRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: 'mantineLayout',
    component: () => (
        <Suspense fallback={null}>
            <MantineLayout>
                <Outlet />
            </MantineLayout>
        </Suspense>
    ),
})

const studentRoute = createRoute({
    getParentRoute: () => mantineLayoutRoute,
    path: '/student',
    component: Home,
})

const adminGuardRoute = createRoute({
    getParentRoute: () => mantineLayoutRoute,
    id: 'adminGuard',
    beforeLoad: () => {if (useSessionStore.getState().adminRole == null) {throw redirect({ to: '/' })}}
})

const adminHomeRoute = createRoute({
    getParentRoute: () => adminGuardRoute,
    path: '/admin',
    component: AdminHome,
})

const adminNewRoute = createRoute({
    getParentRoute: () => adminGuardRoute,
    path: '/admin/new',
    component: CreateCase,
})

const adminNewScratchRoute = createRoute({
    getParentRoute: () => adminGuardRoute,
    path: '/admin/new/scratch',
    component: () => <CaseForm />,
})

const adminNewTemplateRoute = createRoute({
    getParentRoute: () => adminGuardRoute,
    path: '/admin/new/template',
    component: TemplatePicker,
})

const adminNewFormRoute = createRoute({
    getParentRoute: () => adminGuardRoute,
    path: '/admin/new/form',
    validateSearch: (search) => ({
        template: search.template ? String(search.template) : undefined
    }),
    component: () => {
        const { template } = adminNewFormRoute.useSearch()
        return <CaseForm templateId={template} />
    },
})

const adminEditRoute = createRoute({
    getParentRoute: () => adminGuardRoute,
    path: '/admin/edit',
    component: () => <TemplatePicker mode="edit" />,
})

const adminEditFormRoute = createRoute({
    getParentRoute: () => adminGuardRoute,
    path: '/admin/edit/form',
    validateSearch: (search) => ({
        caseId: search.caseId ? String(search.caseId) : undefined
    }),
    component: () => {
        const { caseId } = adminEditFormRoute.useSearch()
        return <CaseForm editCaseId={caseId} />
    },
})

const adminAdminsRoute = createRoute({
    getParentRoute: () => adminGuardRoute,
    path: '/admin/admins',
    beforeLoad: () => {
        if (useSessionStore.getState().adminRole !== ADMIN_ROLE.SUPER) {
            throw redirect({ to: '/admin' })
        }
    },
    component: Admins,
})

const routeTree = rootRoute.addChildren([
    indexRoute,
    mantineLayoutRoute.addChildren([
        studentRoute,
        adminGuardRoute.addChildren([
            adminHomeRoute,
            adminNewRoute,
            adminNewScratchRoute,
            adminNewTemplateRoute,
            adminNewFormRoute,
            adminEditRoute,
            adminEditFormRoute,
            adminAdminsRoute,
        ]),
    ]),
])

export const router = createRouter({ routeTree })
