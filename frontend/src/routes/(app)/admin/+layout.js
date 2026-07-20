import { requireAdmin } from '$lib/auth.js'

export function load() {
    requireAdmin()
}
