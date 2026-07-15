import {
    Accordion,
    Alert,
    Button,
    Container,
    Group,
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
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '../../client.js'
import { useCaseSubmit } from '../../hooks/useCaseSubmit.js'
import { buildHTMLDoc, downloadForm } from './exportCase.js'
import {
    collectReferredPersonas,
    createEmptyPersona,
    getPersonaFieldErrors,
    getPersonaLabel,
    hasFieldErrors,
    normalizePersona,
    normalizeReferral,
} from './Helpers.js'
import { CaseImportError, parseCaseHtmlDocument } from './importCase.js'
import PersonaFields from './PersonaFields.jsx'

const MAX_SIMULATION_DURATION = 120

function CaseForm({ templateId, editCaseId }) {
    const [caseName, setCaseName] = useState('')
    const [initialBrief, setInitialBrief] = useState('')
    const [commonInformation, setCommonInformation] = useState('')
    const [simulationDurationMinutes, setSimulationDurationMinutes] = useState(null)
    const [accessCode, setAccessCode] = useState('')
    const [totalPersonas, setTotalPersonas] = useState(null)
    const [personas, setPersonas] = useState([])
    const isEditMode = Boolean(editCaseId)
    const showPersonas = typeof totalPersonas === 'number' && totalPersonas >= 1
    const sourceCaseId = editCaseId || templateId

    // Import is only offered on the blank "from scratch" new-case route
    const canImport = !sourceCaseId

    const [showFieldErrors, setShowFieldErrors] = useState(false)
    const revealErrors = useCallback(() => setShowFieldErrors(true), [])
    const [importWarnings, setImportWarnings] = useState([])
    const [importError, setImportError] = useState('')
    const fileInputRef = useRef(null)

    // `recipe` mutates an Immer draft of the target persona; Immer produces the new immutable state.
    // The target is normalized first so recipes can freely touch its files/referrals arrays.
    const updatePersonaAt = useCallback(
        (index, recipe) => {
            revealErrors()
            setPersonas(
                produce((draft) => {
                    draft[index] = normalizePersona(draft[index])
                    recipe(draft[index])
                }),
            )
        },
        [revealErrors],
    )

    // path — walk down the referral tree to the referred persona.
    const updateReferredPersona = useCallback(
        (path, recipe) => {
            revealErrors()
            setPersonas(
                produce((draft) => {
                    draft[path[0]] = normalizePersona(draft[path[0]])
                    let persona = draft[path[0]]
                    for (let depth = 1; depth < path.length; depth++) {
                        const referralIndex = path[depth]
                        persona.referrals[referralIndex] = normalizeReferral(persona.referrals[referralIndex])
                        persona = persona.referrals[referralIndex].persona
                    }
                    recipe(persona)
                }),
            )
        },
        [revealErrors],
    )

    const caseNameError = !caseName.trim() ? 'Case name is required.' : null
    const initialBriefError = !initialBrief.trim() ? 'Initial brief is required.' : null
    const accessCodeError = !accessCode.trim() ? 'Access code is required.' : null

    const totalPersonasError =
        typeof totalPersonas !== 'number' || totalPersonas < 1
            ? 'At least 1 persona is required'
            : null

    const simulationDurationError =
        typeof simulationDurationMinutes === 'number' &&
        (simulationDurationMinutes > MAX_SIMULATION_DURATION ||
            simulationDurationMinutes < 1)
            ? `Simulation duration must be between 1 and ${MAX_SIMULATION_DURATION} minutes (2 hours).`
            : null

    const {
        data: loadedCase,
        isFetching: isLoadingTemplate,
        error: loadError,
    } = useQuery({
        queryKey: ['case', sourceCaseId],
        queryFn: () => apiFetch(`/api/cases/${sourceCaseId}`),
        enabled: Boolean(sourceCaseId),
    })

    const { submitError, submitSuccess, submitCase } = useCaseSubmit({
        isEditMode, editCaseId
    })

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
        revealErrors()
    }, [loadedCase, revealErrors])

    useEffect(() => {
        if (loadError) {
            setLoadErrorMessage(
                loadError.message ||
                    (isEditMode ? 'Failed to load case for editing.' : 'Failed to load case template.'))
        }
    }, [loadError, isEditMode])

    const handleSubmit = (event) => {
        event.preventDefault()
        setLoadErrorMessage('')
        submitCase({
            caseName,
            initialBrief,
            commonInformation,
            simulationDurationMinutes,
            accessCode,
            totalPersonas,
            personas,
        })
    }

    // Builds a .html form from whatever's currently in this form
    const handleExportTemplate = () => {
        const html = buildHTMLDoc({
            caseName,
            accessCode,
            simulationDurationMinutes,
            initialBrief,
            commonInformation,
            personas,
        })
        downloadForm(html, caseName)
    }

    const handleImportClick = () => fileInputRef.current?.click()

    // Parses a filled-in export back into form state
    const handleImportFile = async (event) => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (!file) return

        const hasExistingData =
            caseName.trim() || initialBrief.trim() || accessCode.trim() || personas.length > 0
        if (hasExistingData && !window.confirm('Import will replace everything currently in this form. Continue?')) {
            return
        }

        setImportError('')
        setImportWarnings([])
        try {
            const text = await file.text()
            const { data, warnings } = parseCaseHtmlDocument(text)
            setCaseName(data.caseName)
            setAccessCode(data.accessCode)
            setInitialBrief(data.initialBrief)
            setCommonInformation(data.commonInformation)
            setSimulationDurationMinutes(data.simulationDurationMinutes)
            setTotalPersonas(data.totalPersonas)
            setPersonas(data.personas)
            setImportWarnings(warnings)
            revealErrors()
        } catch (error) {
            setImportError(
                error instanceof CaseImportError
                    ? error.message
                    : 'Failed to read that file. Make sure it’s an unmodified export from this app.',
            )
        }
    }

    const referredPersonas = collectReferredPersonas(personas)
    const displayedError = submitError || loadErrorMessage

    const rootPersonaErrors = Array.from({ length: showPersonas ? totalPersonas : 0 }, (_, index) =>
        getPersonaFieldErrors(normalizePersona(personas[index])),
    )
    const referredPersonaErrors = referredPersonas.map((item) => getPersonaFieldErrors(item.persona))
    const hasAnyPersonaError =
        rootPersonaErrors.some(hasFieldErrors) || referredPersonaErrors.some(hasFieldErrors)
    const hasValidationErrors =
        Boolean(caseNameError) ||
        Boolean(initialBriefError) ||
        Boolean(accessCodeError) ||
        Boolean(totalPersonasError) ||
        Boolean(simulationDurationError) ||
        hasAnyPersonaError

    return (
        <div className="relative min-h-screen bg-parchment">
            <div className="absolute inset-x-0 top-0 h-1 bg-brand" aria-hidden="true" />
            <Container size="2xl" py="xl">
                <Paper radius="lg" p="xl" withBorder shadow="sm" style={{ borderColor: '#e4dfd5' }}>
                    <form onSubmit={handleSubmit}>
                        <Stack gap="lg">
                            <div className="relative">
                                <div className="text-center">
                                    <p className="font-mono text-[11px] font-medium uppercase tracking-[0.28em] text-brand">
                                        Case Builder
                                    </p>
                                    <Title order={1} ta="center" mt={6}>
                                        {isEditMode ? 'Edit Case Study' : 'New Case Study'}
                                    </Title>
                                </div>
                                <div className="absolute right-0 top-0">
                                    <Group gap="xs">
                                        {canImport && (
                                            <>
                                                <input
                                                    ref={fileInputRef}
                                                    type="file"
                                                    accept=".html,.htm,text/html"
                                                    className="hidden"
                                                    onChange={handleImportFile}
                                                />
                                                <Button
                                                    type="button"
                                                    variant="outline"
                                                    size="xs"
                                                    onClick={handleImportClick}
                                                >
                                                    Import template
                                                </Button>
                                            </>
                                        )}
                                        <Button
                                            type="button"
                                            variant="outline"
                                            size="xs"
                                            onClick={handleExportTemplate}
                                        >
                                            Export template
                                        </Button>
                                    </Group>
                                </div>
                            </div>
                        {isLoadingTemplate && (
                            <Text c="dimmed" size="sm" ta="center">
                                {isEditMode ? 'Loading case...' : 'Loading case template...'}
                            </Text>
                        )}
                        {importError && (
                            <Alert color="red" variant="light" withCloseButton onClose={() => setImportError('')}>
                                {importError}
                            </Alert>
                        )}
                        {importWarnings.length > 0 && (
                            <Alert
                                color="yellow"
                                variant="light"
                                title={`Imported with ${importWarnings.length} issue${importWarnings.length === 1 ? '' : 's'} to review`}
                                withCloseButton
                                onClose={() => setImportWarnings([])}
                            >
                                <Stack gap={4}>
                                    {importWarnings.map((warning) => (
                                        <Text key={warning} size="sm">
                                            {warning}
                                        </Text>
                                    ))}
                                </Stack>
                            </Alert>
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
                                            error={showFieldErrors ? caseNameError : null}
                                            onChange={(event) => {
                                                revealErrors()
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
                                            error={showFieldErrors ? initialBriefError : null}
                                            onChange={(event) => {
                                                revealErrors()
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
                                            max={MAX_SIMULATION_DURATION}
                                            allowDecimal={false}
                                            hideControls
                                            value={simulationDurationMinutes}
                                            error={simulationDurationError}
                                            onChange={(value) => {
                                                revealErrors()
                                                setSimulationDurationMinutes(value)
                                            }}
                                        />
                                        <TextInput
                                            label="Access code"
                                            placeholder="Enter access code"
                                            required
                                            value={accessCode}
                                            error={showFieldErrors ? accessCodeError : null}
                                            onChange={(event) => {
                                                revealErrors()
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
                                            error={showFieldErrors ? totalPersonasError : null}
                                            onChange={(value) => {
                                                revealErrors()
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
                                                                errors={
                                                                    showFieldErrors
                                                                        ? rootPersonaErrors[index]
                                                                        : {}
                                                                }
                                                            />
                                                        </Accordion.Panel>
                                                    </Accordion.Item>
                                                )
                                            })}
                                            {referredPersonas.map((item, referredIndex) => {
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
                                                                    updateReferredPersona(
                                                                        item.path,
                                                                        recipe,
                                                                    )
                                                                }
                                                                errors={
                                                                    showFieldErrors
                                                                        ? referredPersonaErrors[
                                                                              referredIndex
                                                                          ]
                                                                        : {}
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
                        {showFieldErrors && hasValidationErrors && (
                            <Text c="red" size="sm">
                                Resolve the highlighted fields above before submitting.
                            </Text>
                        )}
                        <Button
                            type="submit"
                            disabled={isLoadingTemplate || hasValidationErrors}
                        >
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
