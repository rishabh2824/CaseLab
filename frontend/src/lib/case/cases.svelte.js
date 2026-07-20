import { apiFetch } from '../api/client.js'

class CasesStore {
    list = $state([])
    isLoading = $state(false)
    error = $state('')

    async fetchAll() {
        this.isLoading = true
        this.error = ''
        try {
            const data = await apiFetch('/api/cases')
            this.list = data?.cases ?? []
        } catch (err) {
            this.error = err.message || 'Failed to load cases.'
        } finally {
            this.isLoading = false
        }
    }

    async deleteCase(caseId) {
        await apiFetch(`/api/cases/${caseId}`, { method: 'DELETE' })
        this.list = this.list.filter((c) => c.id !== caseId)
    }
}

export const cases = new CasesStore()
