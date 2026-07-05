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
import { useMutation, useQuery } from '@tanstack/react-query'
import { useSearch } from '@tanstack/react-router'
import { produce } from 'immer'
import { useEffect, useState } from 'react'
import { apiFetch } from '../../client.js'
import { useSessionStore } from '../../hooks/sessionStore.js'
import { slugify } from '../student/Helpers.js'
import {
    createEmptyPersona,
    getPersonaLabel,
    normalizePersona,
    normalizeReferral,
} from './Helpers.js'
import PersonaFields from './PersonaFields.jsx'

function CaseForm() {
    const [submitError, setSubmitError] = useState('')
    const [submitSuccess, setSubmitSuccess] = useState('')
    const [caseName, setCaseName] = useState('')
    const [initialBrief, setInitialBrief] = useState('')
    const [commonInformation, setCommonInformation] = useState('')
    const [simulationDurationMinutes, setSimulationDurationMinutes] = useState(null)
    const [accessCode, setAccessCode] = useState('')
    const [totalPersonas, setTotalPersonas] = useState(null)
    const [personas, setPersonas] = useState([])
    const search = useSearch({ strict: false })
    // Admin endpoints require the token the admin entered on the home screen.
    const adminToken = useSessionStore((s) => s.adminToken)
    const templateId = search.template
    const editCaseId = search.caseId
    const isEditMode = Boolean(editCaseId)
    const showPersonas = typeof totalPersonas === 'number' && totalPersonas >= 1
    // `recipe` mutates an Immer draft of the target persona; Immer produces the
    // new immutable state. The target is normalized first so recipes can freely
    // touch its files/referrals arrays.
    const updatePersonaAt = (index, recipe) => {
        setPersonas(
            produce((draft) => {
                draft[index] = normalizePersona(draft[index])
                recipe(draft[index])
            }),
        )
    }
    // path = [rootIndex, referralIndex, referralIndex, ...] — walk down the
    // referral tree (normalizing each hop) to the referred persona, then apply.
    const updateReferredPersonaByPath = (path, recipe) => {
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
    }
    const totalPersonasError =
        typeof totalPersonas === 'number' && totalPersonas < 1
            ? 'At least 1 persona is required'
            : null
    const hasUnscheduledRootPersona = personas.some((persona) => {
        const normalized = normalizePersona(persona)
        return typeof normalized.scheduledAfterMinutes !== 'number'
    })
    const sourceCaseId = editCaseId || templateId

    const {
        data: loadedCase,
        isFetching: isLoadingTemplate,
        error: loadError,
    } = useQuery({
        queryKey: ['case', sourceCaseId],
        queryFn: () => apiFetch(`/api/cases/${sourceCaseId}`, { adminToken }),
        enabled: Boolean(sourceCaseId),
    })

    useEffect(() => {
        if (!loadedCase?.case) return
        const templateCase = loadedCase.case
        setCaseName(templateCase.caseName ?? '')
        setInitialBrief(templateCase.initialBrief ?? '')
        setCommonInformation(templateCase.commonInformation ?? '')
        setSimulationDurationMinutes(templateCase.simulationDurationMinutes ?? null)
        setAccessCode(templateCase.accessCode ?? '')
        setTotalPersonas(templateCase.totalNonReferredPersonas ?? null)
        setPersonas((templateCase.personas ?? []).map((persona) => normalizePersona(persona)))
    }, [loadedCase])

    useEffect(() => {
        if (loadError) {
            setSubmitError(
                loadError.message ||
                    (isEditMode
                        ? 'Failed to load case for editing.'
                        : 'Failed to load case template.'),
            )
        }
    }, [loadError, isEditMode])

    const saveMutation = useMutation({
        mutationFn: (payload) =>
            apiFetch(isEditMode ? `/api/cases/${editCaseId}` : '/api/cases', {
                method: isEditMode ? 'PUT' : 'POST',
                adminToken,
                body: payload,
            }),
        onSuccess: () =>
            setSubmitSuccess(
                isEditMode ? 'Case updated successfully.' : 'Case saved successfully.',
            ),
        onError: (error) => {
            setSubmitError(error.message || 'Upload failed.')
            setSubmitSuccess('')
        },
    })

    const handleSubmit = async (event) => {
        event.preventDefault()
        if (typeof totalPersonas !== 'number' || totalPersonas < 1) {
            setSubmitError('Enter the number of AI personas that are not referred (at least 1).')
            setSubmitSuccess('')
            return
        }
        if (!hasUnscheduledRootPersona) {
            setSubmitError('At least one non-referred persona must not be scheduled.')
            setSubmitSuccess('')
            return
        }
        setSubmitError('')
        setSubmitSuccess('')

        const buildPrefix = () => {
            const slug = slugify(caseName)
            return slug ? `cases/${slug}` : 'cases'
        }

        const uploadFile = async (file, prefix) => {
            const presign = await apiFetch('/api/uploads/presign', {
                method: 'POST',
                adminToken,
                body: {
                    file_name: file.name,
                    content_type: file.type || null,
                    prefix,
                },
            })
            const putResponse = await fetch(presign.upload_url, {
                method: 'PUT',
                headers: {
                    'Content-Type': presign.content_type || 'application/octet-stream',
                },
                body: file,
            })
            if (!putResponse.ok) {
                throw new Error('Failed to upload file to Spaces.')
            }
            return {
                bucket: presign.bucket,
                object_key: presign.object_key,
                file_name: presign.file_name,
                content_type: presign.content_type,
            }
        }

        const normalizeFileEntry = async (entry, prefix) => {
            if (!entry?.file) {
                return { ...entry, file: null }
            }
            if (entry.file instanceof File) {
                const uploaded = await uploadFile(entry.file, prefix)
                return { ...entry, file: uploaded }
            }
            return { ...entry }
        }

        const normalizeProfilePhoto = async (profilePhoto, prefix) => {
            if (!profilePhoto) {
                return null
            }
            if (profilePhoto instanceof File) {
                return await uploadFile(profilePhoto, prefix)
            }
            return profilePhoto
        }

        const buildPersonaPayload = async (persona, prefix) => {
            const normalized = normalizePersona(persona)
            const profilePhoto = await normalizeProfilePhoto(normalized.profilePhoto, prefix)
            const files = await Promise.all(
                (normalized.files ?? []).map((entry) => normalizeFileEntry(entry, prefix)),
            )
            const referrals = await Promise.all(
                (normalized.referrals ?? []).map(async (referral) => {
                    const normalizedReferral = normalizeReferral(referral)
                    return {
                        name: normalizedReferral.name,
                        triggerType: normalizedReferral.triggerType,
                        conditions: normalizedReferral.conditions,
                        revealDelayMinutes: normalizedReferral.revealDelayMinutes,
                        persona: await buildPersonaPayload(normalizedReferral.persona, prefix),
                    }
                }),
            )
            return {
                ...normalized,
                profilePhoto,
                files,
                referrals,
            }
        }

        try {
            const prefix = buildPrefix()
            const personasPayload = await Promise.all(
                personas.map((persona) => buildPersonaPayload(persona, prefix)),
            )
            const payload = {
                caseName: caseName.trim(),
                initialBrief: initialBrief.trim(),
                commonInformation: commonInformation.trim(),
                simulationDurationMinutes,
                accessCode: accessCode.trim(),
                totalNonReferredPersonas: totalPersonas,
                personas: personasPayload,
            }
            saveMutation.mutate(payload)
        } catch (error) {
            setSubmitError(error.message || 'Upload failed.')
            setSubmitSuccess('')
        }
    }
    return (
        <Container size="2xl" py="xl">
            <Paper radius="md" p="lg" withBorder>
                <form onSubmit={handleSubmit}>
                    <Stack gap="lg">
                        <Title order={1} ta="center">
                            {isEditMode ? 'Edit Case Study' : 'New Case Study'}
                        </Title>
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
                                            label="Enter common information for all personas"
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
                                            allowDecimal={false}
                                            hideControls
                                            value={simulationDurationMinutes}
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
                                                const updatePersona = (updater) =>
                                                    updatePersonaAt(index, updater)
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
                                                                updatePersona={updatePersona}
                                                            />
                                                        </Accordion.Panel>
                                                    </Accordion.Item>
                                                )
                                            })}
                                            {personas.flatMap((persona, index) => {
                                                const basePersona = normalizePersona(persona)
                                                const referredItems = []
                                                const collectReferred = (
                                                    currentPersona,
                                                    path,
                                                    parentLabel,
                                                ) => {
                                                    const normalized =
                                                        normalizePersona(currentPersona)
                                                    normalized.referrals.forEach(
                                                        (referral, referralIndex) => {
                                                            const normalizedReferral =
                                                                normalizeReferral(referral)
                                                            const childPath = [
                                                                ...path,
                                                                referralIndex,
                                                            ]
                                                            const referralLabel = getPersonaLabel(
                                                                { name: normalizedReferral.name },
                                                                'Referred Persona',
                                                            )
                                                            referredItems.push({
                                                                path: childPath,
                                                                persona: normalizePersona(
                                                                    normalizedReferral.persona,
                                                                ),
                                                                label: referralLabel,
                                                                parentLabel,
                                                            })
                                                            const childLabel = getPersonaLabel(
                                                                normalizedReferral.persona,
                                                                'Referred Persona',
                                                            )
                                                            collectReferred(
                                                                normalizePersona(
                                                                    normalizedReferral.persona,
                                                                ),
                                                                childPath,
                                                                childLabel,
                                                            )
                                                        },
                                                    )
                                                }
                                                const baseLabel = getPersonaLabel(
                                                    basePersona,
                                                    `Persona ${index + 1}`,
                                                )
                                                collectReferred(basePersona, [index], baseLabel)
                                                return referredItems.map((item) => {
                                                    const updatePersona = (updater) =>
                                                        updateReferredPersonaByPath(
                                                            item.path,
                                                            updater,
                                                        )
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
                                                                    persona={normalizePersona(
                                                                        item.persona,
                                                                    )}
                                                                    updatePersona={updatePersona}
                                                                />
                                                            </Accordion.Panel>
                                                        </Accordion.Item>
                                                    )
                                                })
                                            })}
                                        </Accordion>
                                    )}
                                </Accordion.Panel>
                            </Accordion.Item>
                        </Accordion>
                        {submitError && (
                            <Text c="red" size="sm">
                                {submitError}
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
    )
}

export default CaseForm
