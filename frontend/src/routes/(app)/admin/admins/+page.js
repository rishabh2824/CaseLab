import { requireSuperAdmin } from '$lib/auth.js'

export function load() {
    requireSuperAdmin()
}
