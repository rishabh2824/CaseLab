import {
    Accordion,
    FileInput,
    NumberInput,
    Select,
    Stack,
    Text,
    Textarea,
    TextInput,
} from '@mantine/core'
import { createEmptyReferral, getPersonaLabel, normalizeReferral } from './Helpers.js'

// `updatePersona(recipe)` applies an Immer recipe to this persona's draft —
// see updatePersonaAt/updateReferredPersonaByPath in caseForm.jsx. Shared by
// both root personas and referred personas, so it must only ever touch
// `persona`/`updatePersona`, never reach outside its own props.
function PersonaFields({ persona, updatePersona }) {
    return (
        <Stack gap="xs">
            <TextInput
                label="Persona name"
                placeholder="Enter persona name"
                required
                value={persona.name}
                onChange={(event) => {
                    const value = event.currentTarget.value
                    updatePersona((d) => {
                        d.name = value
                    })
                }}
            />
            <TextInput
                label="Title/Role"
                placeholder="Enter title or role"
                required
                value={persona.role}
                onChange={(event) => {
                    const value = event.currentTarget.value
                    updatePersona((d) => {
                        d.role = value
                    })
                }}
            />
            <FileInput
                label="Profile photo"
                placeholder="Upload a profile photo"
                accept="image/*"
                value={persona.profilePhoto instanceof File ? persona.profilePhoto : null}
                onChange={(value) => {
                    updatePersona((d) => {
                        d.profilePhoto = value
                    })
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
                    updatePersona((d) => {
                        d.knownFacts = value
                    })
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
                    updatePersona((d) => {
                        d.unknownFacts = value
                    })
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
                    updatePersona((d) => {
                        d.hiddenFacts = value
                    })
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
                    updatePersona((d) => {
                        d.personalityTraits = value
                    })
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
                    updatePersona((d) => {
                        d.scheduledAfterMinutes = value
                    })
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
                    updatePersona((d) => {
                        d.availabilityMinutes = value
                    })
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
                    updatePersona((d) => {
                        const count = typeof value === 'number' && value >= 0 ? value : null
                        d.fileCount = count
                        if (typeof count === 'number') {
                            if (d.files.length > count) {
                                d.files.length = count
                            } else {
                                while (d.files.length < count) {
                                    d.files.push({
                                        file: null,
                                        shareConditions: '',
                                        perceivedContents: '',
                                    })
                                }
                            }
                        }
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
                                            value={
                                                fileEntry.file instanceof File
                                                    ? fileEntry.file
                                                    : null
                                            }
                                            onChange={(value) => {
                                                updatePersona((d) => {
                                                    d.files[fileIndex].file = value
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
                                                updatePersona((d) => {
                                                    d.files[fileIndex].shareConditions = value
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
                                                updatePersona((d) => {
                                                    d.files[fileIndex].perceivedContents = value
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
                    updatePersona((d) => {
                        const count = typeof value === 'number' && value >= 0 ? value : null
                        d.referralOutCount = count
                        if (typeof count !== 'number') {
                            d.referrals = []
                        } else if (d.referrals.length > count) {
                            d.referrals.length = count
                        } else {
                            while (d.referrals.length < count) {
                                d.referrals.push(createEmptyReferral())
                            }
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
                                    {getPersonaLabel({ name: referral.name }, 'Referred Persona')}
                                </Accordion.Control>
                                <Accordion.Panel>
                                    <Stack gap="xs">
                                        <TextInput
                                            label="Name"
                                            placeholder="Enter name"
                                            value={referral.name}
                                            onChange={(event) => {
                                                const value = event.currentTarget.value
                                                updatePersona((d) => {
                                                    d.referrals[referralIndex] = normalizeReferral(
                                                        d.referrals[referralIndex],
                                                    )
                                                    d.referrals[referralIndex].name = value
                                                    d.referrals[referralIndex].persona.name = value
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
                                                updatePersona((d) => {
                                                    d.referrals[referralIndex] = normalizeReferral(
                                                        d.referrals[referralIndex],
                                                    )
                                                    d.referrals[referralIndex].triggerType = value
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
                                                    updatePersona((d) => {
                                                        d.referrals[referralIndex] =
                                                            normalizeReferral(
                                                                d.referrals[referralIndex],
                                                            )
                                                        d.referrals[referralIndex].conditions =
                                                            value
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
                                                    updatePersona((d) => {
                                                        d.referrals[referralIndex] =
                                                            normalizeReferral(
                                                                d.referrals[referralIndex],
                                                            )
                                                        d.referrals[
                                                            referralIndex
                                                        ].revealDelayMinutes = value
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
}

export default PersonaFields
