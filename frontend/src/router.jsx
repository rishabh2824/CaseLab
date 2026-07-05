import {
    createRootRoute,
    createRoute,
    createRouter,
    Outlet,
    redirect,
} from '@tanstack/react-router'
import { useSessionStore } from './hooks/sessionStore.js'
import CreateCase from './pages/admin/CreateCase.jsx'
import CaseForm from './pages/admin/caseForm.jsx'
import AdminHome from './pages/admin/Home.jsx'
import TemplatePicker from './pages/admin/TemplatePicker.jsx'
import LandingHome from './pages/Home.jsx'
import Home from './pages/student/Home.jsx'

const rootRoute = createRootRoute({
    component: () => <Outlet />,
})

const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: LandingHome,
})

const studentRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/student',
    component: Home,
})

// Legacy alias.
const newCaseRedirectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/newCase',
    beforeLoad: () => {
        throw redirect({ to: '/admin/new/scratch' })
    },
})

// Pathless layout gating the admin area behind the admin token. This is UX
// polish only — the API is the real gate (admin endpoints return 401 without a
// valid token). Checked at navigation time; the token is set on the home
// screen and lives in the session store.
const adminGuardRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: 'adminGuard',
    beforeLoad: () => {
        if (!useSessionStore.getState().adminToken) {
            throw redirect({ to: '/' })
        }
    },
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
    component: CaseForm,
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
        template: search.template ? String(search.template) : undefined,
    }),
    component: CaseForm,
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
        caseId: search.caseId ? String(search.caseId) : undefined,
    }),
    component: CaseForm,
})

const routeTree = rootRoute.addChildren([
    indexRoute,
    studentRoute,
    newCaseRedirectRoute,
    adminGuardRoute.addChildren([
        adminHomeRoute,
        adminNewRoute,
        adminNewScratchRoute,
        adminNewTemplateRoute,
        adminNewFormRoute,
        adminEditRoute,
        adminEditFormRoute,
    ]),
])

export const router = createRouter({ routeTree })
