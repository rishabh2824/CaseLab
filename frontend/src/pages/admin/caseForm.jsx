import {
    Accordion,
    Button,
    Container,
    NumberInput,
    Paper,
    Stack,
    Text,
    Textarea,
    TextInput,
    Title,
} from '@mantine/core'
import { useQuery } from '@tanstack/react-query'
import { produce } from 'immer'
import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '../../client.js'
import { useSessionStore } from '../../hooks/sessionStore.js'
import { useCaseSubmit } from '../../hooks/useCaseSubmit.js'
import {
    collectReferredPersonas,
    createEmptyPersona,
    getPersonaLabel,
    normalizePersona,
    normalizeReferral,
} from './Helpers.js'
import PersonaFields from './PersonaFields.jsx'

// The backend enforces this same cap when a case is created/updated
// (settings.MAX_SIMULATION_DURATION_MINUTES) — this is UX only, so an admin
// gets an inline error instead of a failed submit.
const MAX_SIMULATION_DURATION_MINUTES = 120

// templateId/editCaseId come in as props (set by each route's own typed
// useSearch in router.jsx) rather than this component calling
// useSearch({ strict: false }) itself — CaseForm is shared by three routes
// with three different (or no) search schemas, so there's no single route
// it could bind a typed useSearch to directly.
function CaseForm({ templateId, editCaseId }) {
    const [caseName, setCaseName] = useState('')
    const [initialBrief, setInitialBrief] = useState('')
    const [commonInformation, setCommonInformation] = useState('')
    const [simulationDurationMinutes, setSimulationDurationMinutes] = useState(null)
    const [accessCode, setAccessCode] = useState('')
    const [totalPersonas, setTotalPersonas] = useState(null)
    const [personas, setPersonas] = useState([])
    // Admin endpoints require the JWT minted at Google sign-in.
    const adminJwt = useSessionStore((s) => s.adminJwt)
    const isEditMode = Boolean(editCaseId)
    const showPersonas = typeof totalPersonas === 'number' && totalPersonas >= 1
    // `recipe` mutates an Immer draft of the target persona; Immer produces the
    // new immutable state. The target is normalized first so recipes can freely
    // touch its files/referrals arrays.
    const updatePersonaAt = useCallback((index, recipe) => {
        setPersonas(
            produce((draft) => {
                draft[index] = normalizePersona(draft[index])
                recipe(draft[index])
            }),
        )
    }, [])
    // path = [rootIndex, referralIndex, referralIndex, ...] — walk down the
    // referral tree (normalizing each hop) to the referred persona, then apply.
    const updateReferredPersonaByPath = useCallback((path, recipe) => {
        setPersonas(
            produce((draft) => {
                draft[path[0]] = normalizePersona(draft[path[0]])
                let persona = draft[path[0]]
                for (let depth = 1; depth < path.length; depth++) {
                    const referralIndex = path[depth]
                    persona.referrals[referralIndex] = normalizeReferral(
                        persona.referrals[referralIndex],
                    )
                    persona = persona.referrals[referralIndex].persona
                }
                recipe(persona)
            }),
        )
    }, [])

    const totalPersonasError =
        typeof totalPersonas === 'number' && totalPersonas < 1
            ? 'At least 1 persona is required'
            : null
    const simulationDurationError =
        typeof simulationDurationMinutes === 'number' &&
        simulationDurationMinutes > MAX_SIMULATION_DURATION_MINUTES
            ? `Simulation duration cannot exceed ${MAX_SIMULATION_DURATION_MINUTES} minutes (2 hours).`
            : null
    const sourceCaseId = editCaseId || templateId

    const {
        data: loadedCase,
        isFetching: isLoadingTemplate,
        error: loadError,
    } = useQuery({
        queryKey: ['case', sourceCaseId],
        queryFn: () => apiFetch(`/api/cases/${sourceCaseId}`, { adminJwt }),
        enabled: Boolean(sourceCaseId),
    })

    const { submitError, submitSuccess, submitCase } = useCaseSubmit({
        adminJwt,
        isEditMode,
        editCaseId,
    })
    // The hook's submitError is submission-flow-only; a failed template/case
    // load surfaces through the same banner via this effect instead.
    const [loadErrorMessage, setLoadErrorMessage] = useState('')

    useEffect(() => {
        if (!loadedCase?.case) return
        const templateCase = loadedCase.case
        setCaseName(templateCase.case_name ?? '')
        setInitialBrief(templateCase.initial_brief ?? '')
        setCommonInformation(templateCase.common_information ?? '')
        setSimulationDurationMinutes(templateCase.simulation_duration ?? null)
        setAccessCode(templateCase.access_code ?? '')
        setTotalPersonas(templateCase.total_non_referred_personas ?? null)
        setPersonas((templateCase.personas ?? []).map((persona) => normalizePersona(persona)))
    }, [loadedCase])

    useEffect(() => {
        if (loadError) {
            setLoadErrorMessage(
                loadError.message ||
                    (isEditMode
                        ? 'Failed to load case for editing.'
                        : 'Failed to load case template.'),
            )
        }
    }, [loadError, isEditMode])

    const handleSubmit = (event) => {
        event.preventDefault()
        // Matches the pre-extraction behavior of sharing one error banner:
        // attempting a submit clears any stale "failed to load" message too.
        setLoadErrorMessage('')
        submitCase({
            caseName,
            initialBrief,
            commonInformation,
            simulationDurationMinutes,
            accessCode,
            totalPersonas,
            personas,
            simulationDurationError,
        })
    }

    const referredPersonas = collectReferredPersonas(personas)
    const displayedError = submitError || loadErrorMessage

    return (
        <div className="relative min-h-screen bg-parchment">
            <div className="absolute inset-x-0 top-0 h-1 bg-brand" aria-hidden="true" />
            <Container size="2xl" py="xl">
                <Paper radius="lg" p="xl" withBorder shadow="sm" style={{ borderColor: '#e4dfd5' }}>
                    <form onSubmit={handleSubmit}>
                        <Stack gap="lg">
                            <div className="text-center">
                                <p className="font-mono text-[11px] font-medium uppercase tracking-[0.28em] text-brand">
                                    Case Builder
                                </p>
                                <Title order={1} ta="center" mt={6}>
                                    {isEditMode ? 'Edit Case Study' : 'New Case Study'}
                                </Title>
                            </div>
                        {isLoadingTemplate && (
                            <Text c="dimmed" size="sm" ta="center">
                                {isEditMode ? 'Loading case...' : 'Loading case template...'}
                            </Text>
                        )}

                        <Accordion defaultValue="case-info" variant="separated">
                            {/*Section 1*/}
                            <Accordion.Item value="case-info">
                                <Accordion.Control fw={700} fz="lg">
                                    Case Information
                                </Accordion.Control>
                                <Accordion.Panel>
                                    <Stack gap="md">
                                        <TextInput
                                            label="Case name"
                                            placeholder="Enter case name"
                                            required
                                            value={caseName}
                                            onChange={(event) => {
                                                setCaseName(event.currentTarget.value)
                                            }}
                                        />
                                        <Textarea
                                            label="Initial brief"
                                            placeholder="Summarize the initial brief"
                                            minRows={3}
                                            autosize
                                            required
                                            value={initialBrief}
                                            onChange={(event) => {
                                                setInitialBrief(event.currentTarget.value)
                                            }}
                                        />
                                        <Textarea
                                            label="Enter Case Background"
                                            placeholder="Describe the common information"
                                            minRows={3}
                                            autosize
                                            value={commonInformation}
                                            onChange={(event) => {
                                                setCommonInformation(event.currentTarget.value)
                                            }}
                                        />
                                        <NumberInput
                                            label="Simulation duration (Minutes)"
                                            placeholder="Leave empty for unlimited"
                                            min={1}
                                            max={MAX_SIMULATION_DURATION_MINUTES}
                                            allowDecimal={false}
                                            hideControls
                                            value={simulationDurationMinutes}
                                            error={simulationDurationError}
                                            onChange={setSimulationDurationMinutes}
                                        />
                                        <TextInput
                                            label="Access code"
                                            placeholder="Enter access code"
                                            required
                                            value={accessCode}
                                            onChange={(event) => {
                                                setAccessCode(event.currentTarget.value)
                                            }}
                                        />
                                        <NumberInput
                                            label="Enter the Number of AI personas that are not referred"
                                            placeholder="e.g., 5"
                                            min={1}
                                            allowDecimal={false}
                                            required
                                            hideControls
                                            value={totalPersonas}
                                            error={totalPersonasError}
                                            onChange={(value) => {
                                                setTotalPersonas(value)
                                                if (typeof value === 'number' && value >= 1) {
                                                    setPersonas((prev) => {
                                                        const next = [...prev]
                                                        if (next.length > value) {
                                                            return next.slice(0, value)
                                                        }
                                                        while (next.length < value) {
                                                            next.push(createEmptyPersona())
                                                        }
                                                        return next
                                                    })
                                                } else {
                                                    setPersonas([])
                                                }
                                            }}
                                        />
                                    </Stack>
                                </Accordion.Panel>
                            </Accordion.Item>
                            <Accordion.Item value="ai-personas">
                                <Accordion.Control fw={700} fz="lg">
                                    AI Personas
                                </Accordion.Control>
                                <Accordion.Panel>
                                    {showPersonas && (
                                        <Accordion variant="separated">
                                            {Array.from({ length: totalPersonas }, (_, index) => {
                                                const personaNumber = index + 1
                                                const persona = normalizePersona(personas[index])
                                                const personaLabel = getPersonaLabel(
                                                    persona,
                                                    `Persona ${personaNumber}`,
                                                )
                                                return (
                                                    <Accordion.Item
                                                        key={`persona-${personaNumber}`}
                                                        value={`persona-${personaNumber}`}
                                                    >
                                                        <Accordion.Control>
                                                            {personaLabel}
                                                        </Accordion.Control>
                                                        <Accordion.Panel>
                                                            <PersonaFields
                                                                persona={persona}
                                                                updatePersona={(recipe) =>
                                                                    updatePersonaAt(index, recipe)
                                                                }
                                                            />
                                                        </Accordion.Panel>
                                                    </Accordion.Item>
                                                )
                                            })}
                                            {referredPersonas.map((item) => {
                                                const pathKey = item.path.join('-')
                                                return (
                                                    <Accordion.Item
                                                        key={`referred-${pathKey}`}
                                                        value={`referred-${pathKey}`}
                                                    >
                                                        <Accordion.Control>
                                                            {`${item.label} <- ${item.parentLabel}`}
                                                        </Accordion.Control>
                                                        <Accordion.Panel>
                                                            <PersonaFields
                                                                persona={item.persona}
                                                                updatePersona={(recipe) =>
                                                                    updateReferredPersonaByPath(
                                                                        item.path,
                                                                        recipe,
                                                                    )
                                                                }
                                                            />
                                                        </Accordion.Panel>
                                                    </Accordion.Item>
                                                )
                                            })}
                                        </Accordion>
                                    )}
                                </Accordion.Panel>
                            </Accordion.Item>
                        </Accordion>
                        {displayedError && (
                            <Text c="red" size="sm">
                                {displayedError}
                            </Text>
                        )}
                        {submitSuccess && (
                            <Text c="green" size="sm">
                                {submitSuccess}
                            </Text>
                        )}
                        <Button type="submit" disabled={isLoadingTemplate}>
                            Submit
                        </Button>
                    </Stack>
                </form>
            </Paper>
            </Container>
        </div>
    )
}

export default CaseForm
