import { redirect } from '@sveltejs/kit'
import { ADMIN_ROLE } from './constants.js'
import { session } from './session.svelte.js'

// Route guard for any admin-only page.
export function requireAdmin() {
    if (session.adminRole == null) redirect(302, '/')
}

export function requireSuperAdmin() {
    requireAdmin()
    if (session.adminRole !== ADMIN_ROLE.SUPER) redirect(302, '/admin')
}
