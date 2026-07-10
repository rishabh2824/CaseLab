import {
    createRootRoute,
    createRoute,
    createRouter,
    Outlet,
    redirect,
} from '@tanstack/react-router'
import { useSessionStore } from './hooks/sessionStore.js'
import Admins from './pages/admin/Admins.jsx'
import CreateCase from './pages/admin/CreateCase.jsx'
import CaseForm from './pages/admin/caseForm.jsx'
import AdminHome from './pages/admin/Home.jsx'
import Login from './pages/admin/Login.jsx'
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

// Public: Google Sign-In. Not behind adminGuardRoute — signing in is how you
// get an adminJwt in the first place.
const adminLoginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/admin/login',
    component: Login,
})

// Pathless layout gating the admin area behind the admin session JWT. This is
// UX polish only — the API is the real gate (admin endpoints return 401
// without a valid, non-expired JWT for an admin that still exists). Checked
// at navigation time; the JWT is set by Login.jsx and lives in the session
// store.
const adminGuardRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: 'adminGuard',
    beforeLoad: () => {
        if (!useSessionStore.getState().adminJwt) {
            throw redirect({ to: '/admin/login' })
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

// Super-admin only, on top of the base admin guard: redirect a plain admin
// (role 2) back to /admin rather than letting them see the admin-management
// page. The API is still the real gate (require_super_admin, 403 otherwise).
const adminAdminsRoute = createRoute({
    getParentRoute: () => adminGuardRoute,
    path: '/admin/admins',
    beforeLoad: () => {
        if (useSessionStore.getState().adminRole !== 1) {
            throw redirect({ to: '/admin' })
        }
    },
    component: Admins,
})

const routeTree = rootRoute.addChildren([
    indexRoute,
    studentRoute,
    newCaseRedirectRoute,
    adminLoginRoute,
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
])

export const router = createRouter({ routeTree })
