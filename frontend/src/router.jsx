import {createRootRoute, createRoute, createRouter, Outlet, redirect} from '@tanstack/react-router'
import { lazy, Suspense } from 'react'
import { ADMIN_ROLE } from './constants.js'
import { useSessionStore } from './hooks/sessionStore.js'
import LandingHome from './pages/Home.jsx'
import Home from './pages/student/Home.jsx'

// Keep the admin flow out of simulation workflow loads
const Admins = lazy(() => import('./pages/admin/Admins.jsx'))
const CreateCase = lazy(() => import('./pages/admin/CreateCase.jsx'))
const CaseForm = lazy(() => import('./pages/admin/caseForm.jsx'))
const AdminHome = lazy(() => import('./pages/admin/Home.jsx'))
const TemplatePicker = lazy(() => import('./pages/admin/TemplatePicker.jsx'))

const rootRoute = createRootRoute({
    component: () => (<Suspense fallback={null}><Outlet /></Suspense>)})

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

const adminGuardRoute = createRoute({
    getParentRoute: () => rootRoute,
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
])

export const router = createRouter({ routeTree })
