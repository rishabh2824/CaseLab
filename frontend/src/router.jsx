import {
    createRootRoute,
    createRoute,
    createRouter,
    Outlet,
    redirect,
} from '@tanstack/react-router'
import { lazy, Suspense } from 'react'
import { ADMIN_ROLE } from './constants.js'
import { useSessionStore } from './hooks/sessionStore.js'
import LandingHome from './pages/Home.jsx'
import Home from './pages/student/Home.jsx'

// Lazy: the admin area (Mantine components, jsPDF's admin-side usages, the
// Google OAuth login button) is dead weight for a student entering an access
// code — this keeps it out of the student path's initial bundle entirely.
const Admins = lazy(() => import('./pages/admin/Admins.jsx'))
const CreateCase = lazy(() => import('./pages/admin/CreateCase.jsx'))
const CaseForm = lazy(() => import('./pages/admin/caseForm.jsx'))
const AdminHome = lazy(() => import('./pages/admin/Home.jsx'))
const TemplatePicker = lazy(() => import('./pages/admin/TemplatePicker.jsx'))

const rootRoute = createRootRoute({
    component: () => (
        <Suspense fallback={null}>
            <Outlet />
        </Suspense>
    ),
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

// Pathless layout gating the admin area behind the admin session JWT. This is
// UX polish only — the API is the real gate (admin endpoints return 401
// without a valid, non-expired JWT for an admin that still exists). Checked
// at navigation time; the JWT is set by AdminGoogleSignInButton and lives in
// the session store. There's no dedicated admin-login route — signing in
// happens directly from the "Admin Login" button on the landing page, so an
// unauthenticated admin is sent back there.
const adminGuardRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: 'adminGuard',
    beforeLoad: () => {
        if (!useSessionStore.getState().adminJwt) {
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
    component: () => <CaseForm />,
})

const adminNewTemplateRoute = createRoute({
    getParentRoute: () => adminGuardRoute,
    path: '/admin/new/template',
    component: TemplatePicker,
})

// component reads this route's own typed useSearch (rather than CaseForm
// calling useSearch({ strict: false }) internally) — CaseForm is shared by
// three routes with three different (or no) search schemas, so there's no
// single route it could bind to directly. Each route resolves its own typed
// search value and hands it down as a plain prop instead.
const adminNewFormRoute = createRoute({
    getParentRoute: () => adminGuardRoute,
    path: '/admin/new/form',
    validateSearch: (search) => ({
        template: search.template ? String(search.template) : undefined,
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
        caseId: search.caseId ? String(search.caseId) : undefined,
    }),
    component: () => {
        const { caseId } = adminEditFormRoute.useSearch()
        return <CaseForm editCaseId={caseId} />
    },
})

// Super-admin only, on top of the base admin guard: redirect a plain admin
// (role 2) back to /admin rather than letting them see the admin-management
// page. The API is still the real gate (require_super_admin, 403 otherwise).
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
        adminAdminsRoute,
    ]),
])

export const router = createRouter({ routeTree })
