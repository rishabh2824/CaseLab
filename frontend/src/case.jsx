import {
    Accordion,
    Button,
    Container,
    FileInput,
    NumberInput,
    Paper,
    Select,
    Stack,
    Text,
    TextInput,
    Textarea,
    Title,
} from '@mantine/core'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

function Case() {
    const [submitError, setSubmitError] = useState('')
    const [submitSuccess, setSubmitSuccess] = useState('')
    const [isLoadingTemplate, setIsLoadingTemplate] = useState(false)
    const [caseName, setCaseName] = useState('')
    const [initialBrief, setInitialBrief] = useState('')
    const [commonInformation, setCommonInformation] = useState('')
    const [simulationDurationMinutes, setSimulationDurationMinutes] = useState(null)
    const [accessCode, setAccessCode] = useState('')
    const [totalPersonas, setTotalPersonas] = useState(null)
    const [personas, setPersonas] = useState([])
    const [searchParams] = useSearchParams()
    const apiBase = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '')
    const templateId = searchParams.get('template')
    const editCaseId = searchParams.get('caseId')
    const isEditMode = Boolean(editCaseId)
    const showPersonas = typeof totalPersonas === 'number' && totalPersonas >= 1
    const createEmptyPersona = (overrides = {}) => ({
        name: '',
        role: '',
        profilePhoto: null,
        knownFacts: '',
        unknownFacts: '',
        hiddenFacts: '',
        personalityTraits: '',
        availabilityMinutes: null,
        scheduledAfterMinutes: null,
        fileCount: null,
        files: [],
        referralOutCount: null,
        referrals: [],
        ...overrides,
    })
    const createEmptyReferral = (overrides = {}) => ({
        name: '',
        triggerType: null,
        conditions: '',
        revealDelayMinutes: null,
        persona: createEmptyPersona(),
        ...overrides,
    })
    const normalizePersona = (persona) => ({
        ...createEmptyPersona(),
        ...(persona ?? {}),
        files: persona?.files ?? [],
        referrals: persona?.referrals ?? [],
    })
    const normalizeReferral = (referral) => ({
        ...createEmptyReferral(),
        ...(referral ?? {}),
        persona: normalizePersona(referral?.persona),
    })
    const updatePersonaAt = (index, updater) => {
        setPersonas((prev) => {
            const next = [...prev]
            const existing = normalizePersona(next[index])
            next[index] = updater(existing)
            return next
        })
    }
    const updateReferredPersonaByPath = (path, updater) => {
        setPersonas((prev) => {
            const next = [...prev]
            const rootIndex = path[0]
            const updateAt = (persona, depth) => {
                if (depth >= path.length) {
                    return updater(normalizePersona(persona))
                }
                const referralIndex = path[depth]
                const referrals = [...(persona.referrals ?? [])]
                const referral = normalizeReferral(referrals[referralIndex])
                const updatedPersona = updateAt(referral.persona, depth + 1)
                referrals[referralIndex] = { ...referral, persona: updatedPersona }
                return { ...persona, referrals }
            }
            const rootPersona = normalizePersona(next[rootIndex])
            next[rootIndex] = updateAt(rootPersona, 1)
            return next
        })
    }
    const getPersonaLabel = (persona, fallback) => {
        const trimmed = persona.name.trim()
        return trimmed.length > 0 ? trimmed : fallback
    }
    const totalPersonasError =
        typeof totalPersonas === 'number' && totalPersonas < 1
            ? 'At least 1 persona is required'
            : null
    const hasUnscheduledRootPersona = personas.some((persona) => {
        const normalized = normalizePersona(persona)
        return typeof normalized.scheduledAfterMinutes !== 'number'
    })
    useEffect(() => {
        const sourceCaseId = editCaseId || templateId
        if (!sourceCaseId) {
            return
        }
        const loadTemplate = async () => {
            setIsLoadingTemplate(true)
            setSubmitError('')
            setSubmitSuccess('')
            try {
                const response = await fetch(`${apiBase}/api/v1/cases/${sourceCaseId}`)
                if (!response.ok) {
                    throw new Error(
                        isEditMode
                            ? 'Failed to load case for editing.'
                            : 'Failed to load case template.',
                    )
                }
                const data = await response.json()
                const templateCase = data.case
                setCaseName(templateCase.caseName ?? '')
                setInitialBrief(templateCase.initialBrief ?? '')
                setCommonInformation(templateCase.commonInformation ?? '')
                setSimulationDurationMinutes(
                    templateCase.simulationDurationMinutes ?? null,
                )
                setAccessCode(templateCase.accessCode ?? '')
                setTotalPersonas(templateCase.totalNonReferredPersonas ?? null)
                setPersonas(
                    (templateCase.personas ?? []).map((persona) =>
                        normalizePersona(persona),
                    ),
                )
            } catch (error) {
                setSubmitError(
                    error.message ||
                        (isEditMode
                            ? 'Failed to load case for editing.'
                            : 'Failed to load case template.'),
                )
            } finally {
                setIsLoadingTemplate(false)
            }
        }
        loadTemplate()
    }, [apiBase, editCaseId, isEditMode, templateId])
    const handleSubmit = async (event) => {
        event.preventDefault()
        if (!hasUnscheduledRootPersona) {
            setSubmitError(
                'At least one non-referred persona must not be scheduled.',
            )
            setSubmitSuccess('')
            return
        }
        setSubmitError('')
        setSubmitSuccess('')

        const buildPrefix = () => {
            const raw = caseName.trim().toLowerCase()
            const slug = raw.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
            return slug ? `cases/${slug}` : 'cases'
        }

        const uploadFile = async (file, prefix) => {
            const response = await fetch(`${apiBase}/api/v1/uploads/presign`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    file_name: file.name,
                    content_type: file.type || null,
                    prefix,
                }),
            })
            if (!response.ok) {
                throw new Error('Failed to get presigned upload URL.')
            }
            const presign = await response.json()
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
            const profilePhoto = await normalizeProfilePhoto(
                normalized.profilePhoto,
                prefix,
            )
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
                        persona: await buildPersonaPayload(
                            normalizedReferral.persona,
                            prefix,
                        ),
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
            const saveResponse = await fetch(
                isEditMode
                    ? `${apiBase}/api/v1/cases/${editCaseId}`
                    : `${apiBase}/api/v1/cases`,
                {
                method: isEditMode ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            })
            if (!saveResponse.ok) {
                throw new Error(
                    isEditMode
                        ? 'Failed to update case in the backend.'
                        : 'Failed to save case to the backend.',
                )
            }
            const saved = await saveResponse.json()
            console.log('Case saved:', saved)
            setSubmitSuccess(
                isEditMode
                    ? 'Case updated successfully.'
                    : 'Case saved successfully.',
            )
        } catch (error) {
            setSubmitError(error.message || 'Upload failed.')
            setSubmitSuccess('')
        }
    }
    const renderPersonaFields = (persona, updatePersona) => (
        <Stack gap="xs">
            <TextInput
                label="Persona name"
                placeholder="Enter persona name"
                required
                value={persona.name}
                onChange={(event) => {
                    const value = event.currentTarget.value
                    updatePersona((prev) => ({ ...prev, name: value }))
                }}
            />
            <TextInput
                label="Title/Role"
                placeholder="Enter title or role"
                required
                value={persona.role}
                onChange={(event) => {
                    const value = event.currentTarget.value
                    updatePersona((prev) => ({ ...prev, role: value }))
                }}
            />
            <FileInput
                label="Profile photo"
                placeholder="Upload a profile photo"
                accept="image/*"
                value={persona.profilePhoto instanceof File ? persona.profilePhoto : null}
                onChange={(value) => {
                    updatePersona((prev) => ({ ...prev, profilePhoto: value }))
                }}
                clearable
            />
            {persona.profilePhoto && !(persona.profilePhoto instanceof File) && (
                <Text size="xs" c="dimmed">
                    Existing photo: {persona.profilePhoto.file_name}
                </Text>
            )}
            <Textarea
                label="Information they know"
                placeholder="- Fact 1\n- Fact 2"
                minRows={3}
                autosize
                value={persona.knownFacts}
                onChange={(event) => {
                    const value = event.currentTarget.value
                    updatePersona((prev) => ({ ...prev, knownFacts: value }))
                }}
            />
            <Textarea
                label="Information they should not know"
                placeholder="- Fact 1\n- Fact 2"
                minRows={3}
                autosize
                value={persona.unknownFacts}
                onChange={(event) => {
                    const value = event.currentTarget.value
                    updatePersona((prev) => ({ ...prev, unknownFacts: value }))
                }}
            />
            <Textarea
                label="Information they know but are reluctant to share"
                placeholder="- Fact 1\n- Fact 2"
                minRows={3}
                autosize
                value={persona.hiddenFacts}
                onChange={(event) => {
                    const value = event.currentTarget.value
                    updatePersona((prev) => ({ ...prev, hiddenFacts: value }))
                }}
            />
            <Textarea
                label="Personality traits"
                placeholder="Describe personality traits"
                minRows={3}
                autosize
                value={persona.personalityTraits}
                onChange={(event) => {
                    const value = event.currentTarget.value
                    updatePersona((prev) => ({ ...prev, personalityTraits: value }))
                }}
            />
            <NumberInput
                label="After how long is the persona scheduled for?"
                placeholder="Leave empty for not scheduled"
                min={1}
                allowDecimal={false}
                hideControls
                value={persona.scheduledAfterMinutes}
                onChange={(value) => {
                    updatePersona((prev) => ({ ...prev, scheduledAfterMinutes: value }))
                }}
            />
            <NumberInput
                label="How long is this persona available for?"
                placeholder="Leave blank for unlimited"
                min={1}
                allowDecimal={false}
                hideControls
                value={persona.availabilityMinutes}
                onChange={(value) => {
                    updatePersona((prev) => ({ ...prev, availabilityMinutes: value }))
                }}
            />
            <NumberInput
                label="How many files does this persona have access to?"
                placeholder="Leave empty for 0"
                min={0}
                allowDecimal={false}
                hideControls
                value={persona.fileCount}
                onChange={(value) => {
                    updatePersona((prev) => {
                        const count = typeof value === 'number' && value >= 0 ? value : null
                        const updatedFiles = [...(prev.files ?? [])]
                        if (typeof count === 'number') {
                            if (updatedFiles.length > count) {
                                updatedFiles.length = count
                            } else {
                                while (updatedFiles.length < count) {
                                    updatedFiles.push({
                                        file: null,
                                        shareConditions: '',
                                        perceivedContents: '',
                                    })
                                }
                            }
                        }
                        return { ...prev, fileCount: count, files: updatedFiles }
                    })
                }}
            />
            {typeof persona.fileCount === 'number' && persona.fileCount > 0 && (
                <Accordion variant="separated">
                    {Array.from({ length: persona.fileCount }, (_, fileIndex) => {
                        const fileNumber = fileIndex + 1
                        const fileEntry = persona.files[fileIndex] ?? {
                            file: null,
                            shareConditions: '',
                            perceivedContents: '',
                        }
                        return (
                            <Accordion.Item
                                key={`persona-file-${fileNumber}`}
                                value={`persona-file-${fileNumber}`}
                            >
                                <Accordion.Control>File {fileNumber}</Accordion.Control>
                                <Accordion.Panel>
                                    <Stack gap="xs">
                                        <FileInput
                                            label="Upload file"
                                            placeholder="Select a file"
                                            value={fileEntry.file instanceof File ? fileEntry.file : null}
                                            onChange={(value) => {
                                                updatePersona((prev) => {
                                                    const nextFiles = [...(prev.files ?? [])]
                                                    const existingFile = nextFiles[fileIndex] ?? {
                                                        file: null,
                                                        shareConditions: '',
                                                        perceivedContents: '',
                                                    }
                                                    nextFiles[fileIndex] = { ...existingFile, file: value }
                                                    return { ...prev, files: nextFiles }
                                                })
                                            }}
                                        />
                                        {fileEntry.file && !(fileEntry.file instanceof File) && (
                                            <Text size="xs" c="dimmed">
                                                Existing file: {fileEntry.file.file_name}
                                            </Text>
                                        )}
                                        <Textarea
                                            label="Describe the conditions under which the persona will share the file"
                                            placeholder="Describe the conditions"
                                            minRows={2}
                                            autosize
                                            value={fileEntry.shareConditions ?? ''}
                                            onChange={(event) => {
                                                const value = event.currentTarget.value
                                                updatePersona((prev) => {
                                                    const nextFiles = [...(prev.files ?? [])]
                                                    const existingFile = nextFiles[fileIndex] ?? {
                                                        file: null,
                                                        shareConditions: '',
                                                        perceivedContents: '',
                                                    }
                                                    nextFiles[fileIndex] = {
                                                        ...existingFile,
                                                        shareConditions: value,
                                                    }
                                                    return { ...prev, files: nextFiles }
                                                })
                                            }}
                                        />
                                        <Textarea
                                            label="What does the persona think is in this file?"
                                            placeholder="Describe perceived contents"
                                            minRows={2}
                                            autosize
                                            value={fileEntry.perceivedContents ?? ''}
                                            onChange={(event) => {
                                                const value = event.currentTarget.value
                                                updatePersona((prev) => {
                                                    const nextFiles = [...(prev.files ?? [])]
                                                    const existingFile = nextFiles[fileIndex] ?? {
                                                        file: null,
                                                        shareConditions: '',
                                                        perceivedContents: '',
                                                    }
                                                    nextFiles[fileIndex] = {
                                                        ...existingFile,
                                                        perceivedContents: value,
                                                    }
                                                    return { ...prev, files: nextFiles }
                                                })
                                            }}
                                        />
                                    </Stack>
                                </Accordion.Panel>
                            </Accordion.Item>
                        )
                    })}
                </Accordion>
            )}
            <NumberInput
                label="How many people does this persona refer out?"
                placeholder="Leave empty for none"
                min={0}
                allowDecimal={false}
                hideControls
                value={persona.referralOutCount}
                onChange={(value) => {
                    updatePersona((prev) => {
                        const count = typeof value === 'number' && value >= 0 ? value : null
                        const nextReferrals =
                            typeof count === 'number' ? [...(prev.referrals ?? [])] : []
                        if (typeof count === 'number') {
                            if (nextReferrals.length > count) {
                                nextReferrals.length = count
                            } else {
                                while (nextReferrals.length < count) {
                                    nextReferrals.push(createEmptyReferral())
                                }
                            }
                        }
                        return {
                            ...prev,
                            referralOutCount: count,
                            referrals: nextReferrals,
                        }
                    })
                }}
            />
            {typeof persona.referralOutCount === 'number' && persona.referralOutCount > 0 && (
                <Accordion variant="separated">
                    {Array.from({ length: persona.referralOutCount }, (_, referralIndex) => {
                        const referral = normalizeReferral(persona.referrals[referralIndex])
                        return (
                            <Accordion.Item
                                key={`persona-referral-${referralIndex}`}
                                value={`persona-referral-${referralIndex}`}
                            >
                                <Accordion.Control>
                                    {getPersonaLabel(
                                        { name: referral.name },
                                        'Referred Persona',
                                    )}
                                </Accordion.Control>
                                <Accordion.Panel>
                                    <Stack gap="xs">
                                        <TextInput
                                            label="Name"
                                            placeholder="Enter name"
                                            value={referral.name}
                                            onChange={(event) => {
                                                const value = event.currentTarget.value
                                                updatePersona((prev) => {
                                                    const nextReferrals = [
                                                        ...(prev.referrals ?? []),
                                                    ]
                                                    const existing = normalizeReferral(
                                                        nextReferrals[referralIndex],
                                                    )
                                                    nextReferrals[referralIndex] = {
                                                        ...existing,
                                                        name: value,
                                                        persona: {
                                                            ...existing.persona,
                                                            name: value,
                                                        },
                                                    }
                                                    return { ...prev, referrals: nextReferrals }
                                                })
                                            }}
                                        />
                                        <Select
                                            label="How is this persona referred out?"
                                            placeholder="Select an option"
                                            data={[
                                                {
                                                    value: 'conditions',
                                                    label: 'After N conditions',
                                                },
                                                { value: 'time', label: 'After N time' },
                                            ]}
                                            value={referral.triggerType}
                                            onChange={(value) => {
                                                updatePersona((prev) => {
                                                    const nextReferrals = [
                                                        ...(prev.referrals ?? []),
                                                    ]
                                                    const existing = normalizeReferral(
                                                        nextReferrals[referralIndex],
                                                    )
                                                    nextReferrals[referralIndex] = {
                                                        ...existing,
                                                        triggerType: value,
                                                    }
                                                    return { ...prev, referrals: nextReferrals }
                                                })
                                            }}
                                            clearable
                                        />
                                        {referral.triggerType === 'conditions' && (
                                            <Textarea
                                                label="Describe the conditions"
                                                placeholder="Describe the conditions"
                                                minRows={2}
                                                autosize
                                                value={referral.conditions}
                                                onChange={(event) => {
                                                    const value = event.currentTarget.value
                                                    updatePersona((prev) => {
                                                        const nextReferrals = [
                                                            ...(prev.referrals ?? []),
                                                        ]
                                                        const existing = normalizeReferral(
                                                            nextReferrals[referralIndex],
                                                        )
                                                        nextReferrals[referralIndex] = {
                                                            ...existing,
                                                            conditions: value,
                                                        }
                                                        return { ...prev, referrals: nextReferrals }
                                                    })
                                                }}
                                            />
                                        )}
                                        {referral.triggerType === 'time' && (
                                            <NumberInput
                                                label="Enter the duration after which the persona is revealed"
                                                placeholder="Enter duration"
                                                min={1}
                                                allowDecimal={false}
                                                hideControls
                                                value={referral.revealDelayMinutes}
                                                onChange={(value) => {
                                                    updatePersona((prev) => {
                                                        const nextReferrals = [
                                                            ...(prev.referrals ?? []),
                                                        ]
                                                        const existing = normalizeReferral(
                                                            nextReferrals[referralIndex],
                                                        )
                                                        nextReferrals[referralIndex] = {
                                                            ...existing,
                                                            revealDelayMinutes: value,
                                                        }
                                                        return { ...prev, referrals: nextReferrals }
                                                    })
                                                }}
                                            />
                                        )}
                                    </Stack>
                                </Accordion.Panel>
                            </Accordion.Item>
                        )
                    })}
                </Accordion>
            )}
        </Stack>
    )

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
                            <Accordion.Control fw={700} fz="lg">Case Information</Accordion.Control>
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
                                                        {renderPersonaFields(persona, updatePersona)}
                                                    </Accordion.Panel>
                                                </Accordion.Item>
                                            )
                                        })}
                                        {personas.flatMap((persona, index) => {
                                            const basePersona = normalizePersona(persona)
                                            const referredItems = []
                                            const collectReferred = (currentPersona, path, parentLabel) => {
                                                const normalized = normalizePersona(currentPersona)
                                                normalized.referrals.forEach((referral, referralIndex) => {
                                                    const normalizedReferral = normalizeReferral(referral)
                                                    const childPath = [...path, referralIndex]
                                                    const referralLabel = getPersonaLabel(
                                                        { name: normalizedReferral.name },
                                                        'Referred Persona',
                                                    )
                                                    referredItems.push({
                                                        path: childPath,
                                                        persona: normalizePersona(normalizedReferral.persona),
                                                        label: referralLabel,
                                                        parentLabel,
                                                    })
                                                    const childLabel = getPersonaLabel(
                                                        normalizedReferral.persona,
                                                        'Referred Persona',
                                                    )
                                                    collectReferred(
                                                        normalizePersona(normalizedReferral.persona),
                                                        childPath,
                                                        childLabel,
                                                    )
                                                })
                                            }
                                            const baseLabel = getPersonaLabel(
                                                basePersona,
                                                `Persona ${index + 1}`,
                                            )
                                            collectReferred(basePersona, [index], baseLabel)
                                            return referredItems.map((item) => {
                                                const updatePersona = (updater) =>
                                                    updateReferredPersonaByPath(item.path, updater)
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
                                                            {renderPersonaFields(
                                                                normalizePersona(item.persona),
                                                                updatePersona,
                                                            )}
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

export default Case









